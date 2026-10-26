/**
 * tests/harness/gas.js — a small Google Apps Script shim so the real production code
 * in apps-script/src can be exercised from Node without deploying.
 *
 * It implements exactly the surface the backend uses:
 *   SpreadsheetApp, CalendarApp, LockService, PropertiesService, ContentService, Utilities
 *
 * Sheets are seeded from sheet/seed/*.csv (plus the live calendar_config where useful),
 * so tests run against the same schema the live spreadsheet has.
 *
 * Anything unimplemented throws loudly instead of silently returning undefined.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'apps-script', 'src');
const SEED = path.join(ROOT, 'sheet', 'seed');

/* ------------------------------------------------------------------ dates --- */

const TOKEN_MAP = [
  ['yyyy', 'year', '4'],
  ['MMMM', 'month', 'long'],
  ['MMM', 'month', 'short'],
  ['MM', 'month', '2'],
  ['dd', 'day', '2'],
  ['d', 'day', '1'],
  ['EEEE', 'weekday', 'long'],
  ['EEE', 'weekday', 'short'],
  ['HH', 'hour', '2'],
  ['mm', 'minute', '2'],
  ['ss', 'second', '2'],
  ['Z', 'offset', 'compact'],
];

function formatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'long',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const offsetParts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
  const offset = offsetParts.replace('GMT', '') || '+00:00';   // "+11:00"
  const offsetCompact = offset.replace(':', '');
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekdayLong = get('weekday');
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  const second = Number(get('second'));

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const pad = (n, w) => String(n).padStart(w, '0');

  let out = '';
  let i = 0;
  while (i < pattern.length) {
    // Apps Script quotes literal text in a pattern: 'T' -> T
    if (pattern[i] === "'") {
      const end = pattern.indexOf("'", i + 1);
      out += end > -1 ? pattern.slice(i + 1, end) : pattern.slice(i + 1);
      i = end > -1 ? end + 1 : pattern.length;
      continue;
    }
    let matched = false;
    for (const [token, kind, style] of TOKEN_MAP) {
      if (pattern.startsWith(token, i)) {
        let value;
        switch (kind) {
          case 'year': value = String(year); break;
          case 'month':
            value = style === 'long' ? MONTHS[month - 1]
              : style === 'short' ? MONTHS[month - 1].slice(0, 3)
                : pad(month, 2);
            break;
          case 'day': value = style === '2' ? pad(day, 2) : String(day); break;
          case 'weekday': value = style === 'long' ? weekdayLong : weekdayLong.slice(0, 3); break;
          case 'hour': value = pad(hour, 2); break;
          case 'minute': value = pad(minute, 2); break;
          case 'second': value = pad(second, 2); break;
          case 'offset': value = kind === 'offset' ? offsetCompact : ''; break;
          default: value = '';
        }
        out += value;
        i += token.length;
        matched = true;
        break;
      }
    }
    if (!matched) { out += pattern[i]; i += 1; }
  }
  return out;
}

/* ------------------------------------------------------------------ sheets --- */

function readSeed(name) {
  const file = path.join(SEED, name);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const TAB_FILES = {
  Config: 'config.csv',
  Working_Hours: 'working_hours.csv',
  Holidays_Closures: 'holidays_closures.csv',
  Services: 'services.csv',
  Products_Addons: 'products_addons.csv',
  Customers: 'customers.csv',
  Vehicles: 'vehicles.csv',
  Bookings: 'bookings.csv',
  Call_Log: 'call_log.csv',
};

function copy(rows) { return rows.map((r) => r.slice()); }

class Range {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const line = [];
      for (let c = 0; c < this.numCols; c += 1) {
        const data = this.sheet.data[this.row - 1 + r] || [];
        line.push(data[this.col - 1 + c] === undefined ? '' : data[this.col - 1 + c]);
      }
      out.push(line);
    }
    return out;
  }

  getValue() { return this.getValues()[0][0]; }

  setValue(value) {
    const r = this.row - 1;
    while (this.sheet.data.length < r + 1) this.sheet.data.push([]);
    this.sheet.data[r][this.col - 1] = value;
    return this;
  }

  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => {
      const rr = this.row - 1 + r;
      while (this.sheet.data.length < rr + 1) this.sheet.data.push([]);
      this.sheet.data[rr][this.col - 1 + c] = v;
    }));
    return this;
  }

  // formatting calls are no-ops in the harness but must chain
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setVerticalAlignment() { return this; }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
  createFilter() { return this; }
  clear() { return this; }
}

class Sheet {
  constructor(name, data) {
    this.name = name;
    this.data = data;
  }

  getDataRange() {
    const width = this.data.reduce((m, r) => Math.max(m, r.length), 0) || 1;
    return new Range(this, 1, 1, Math.max(this.data.length, 1), width);
  }

  getLastRow() { return this.data.length; }

  getLastColumn() {
    return this.data.reduce((m, r) => Math.max(m, r.length), 0);
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    return new Range(this, row, col, numRows, numCols);
  }

  appendRow(values) {
    this.data.push(values.slice());
  }

  getFilter() { return null; }
  setFrozenRows() {}
  setTabColor() {}
  setColumnWidth() {}
  clear() { this.data = []; }
}

class Spreadsheet {
  constructor() {
    this.sheets = {};
    Object.entries(TAB_FILES).forEach(([tab, file]) => {
      this.sheets[tab] = new Sheet(tab, readSeed(file));
    });
    this.sheets.Holidays_Closures.data.forEach((r, i) => {
      if (i > 0 && r[0]) this.normaliseHoliday(r);
    });
  }

  normaliseHoliday(row) { /* dates stay strings; code handles both */ }

  getSheetByName(name) { return this.sheets[name] || null; }

  getId() { return 'harness-sheet'; }
}

/* --------------------------------------------------------------- calendar --- */

let eventSeq = 0;

class CalendarEvent {
  constructor(calendar, title, start, end, opts = {}) {
    this.calendar = calendar;
    this.id = `harness_evt_${++eventSeq}`;
    this.title = title;
    this.start = new Date(start);
    this.end = new Date(end);
    this.description = opts.description || '';
    this.deleted = false;
  }

  getId() { return this.id; }
  getTitle() { return this.title; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  getDescription() { return this.description; }
  isAllDay() { return false; }
  setTime(start, end) { this.start = new Date(start); this.end = new Date(end); return this; }
  setDescription(d) { this.description = d; return this; }
  deleteEvent() { this.deleted = true; this.calendar.events = this.calendar.events.filter((e) => e !== this); }
}

class Calendar {
  constructor(id) { this.id = id; this.events = []; }

  createEvent(title, start, end, opts = {}) {
    const ev = new CalendarEvent(this, title, start, end, opts);
    this.events.push(ev);
    return ev;
  }

  getEvents(start, end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return this.events.filter((ev) => ev.end.getTime() > s && ev.start.getTime() < e);
  }

  getEventById(id) {
    return this.events.find((ev) => ev.id === id || ev.id.includes(id)) || null;
  }
}

/* ----------------------------------------------------------------- runtime --- */

function createContext(options = {}) {
  const spreadsheet = new Spreadsheet();
  const calendars = new Map();
  const calendarId = options.calendarId || 'primary-test@group.calendar.google.com';
  calendars.set(calendarId, new Calendar(calendarId));
  const token = options.token === undefined ? 'test-token-123' : options.token;
  const props = new Map();
  if (token) props.set('SHARED_TOKEN', token);
  if (options.props) Object.entries(options.props).forEach(([k, v]) => props.set(k, v));

  const noopChain = new Proxy({}, { get: () => () => noopChain });

  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    Utilities: { formatDate },
    Logger: { log: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
    },
    CalendarApp: {
      getCalendarById: (id) => calendars.get(id) || null,
      getDefaultCalendar: () => calendars.get(calendarId),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        hasLock: () => true,
        releaseLock: () => {},
        waitLock: () => {},
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        getProperties: () => Object.fromEntries(props),
      }),
      getUserProperties: () => ({ getProperty: () => null }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => {
        const out = {
          text,
          mime: 'text/plain',
          setMimeType(m) { out.mime = m; return out; },
          getContent() { return out.text; },
          getMimeType() { return out.mime; },
        };
        return out;
      },
    },
    HtmlService: noopChain,
  };

  const context = vm.createContext(sandbox);

  // Apps Script concatenates all .gs files into one global scope; mirror that.
  const order = ['util.js', 'config.js', 'availability.js', 'customers.js', 'bookings.js', 'logging.js', 'api.js'];
  for (const file of order) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  // a real workshop has Config.calendar_id filled in; mirror that in the harness
  const configSheet = spreadsheet.getSheetByName('Config');
  configSheet.data.forEach((row, i) => {
    if (i > 0 && row[0] === 'calendar_id') row[1] = calendarId;
  });

  return { context, spreadsheet, calendars, calendarId, token };
}

/**
 * Call the real doPost/doGet path exactly like a web request would.
 * @param {object} ctx from createContext
 * @param {object} body JSON payload
 * @param {object} opts {token, asGet, raw}
 */
function call(ctx, body, opts = {}) {
  const payload = { ...body };
  if (opts.token !== null) {
    const t = opts.token === undefined ? ctx.token : opts.token;
    if (t) payload.token = t;
  }
  const event = opts.asGet
    ? { parameter: { ...payload } }
    : { parameter: {}, postData: { contents: JSON.stringify(payload) } };
  const fn = opts.asGet ? 'doGet' : 'doPost';
  const result = ctx.context[fn](event);
  const text = result && result.getContent ? result.getContent() : String(result);
  try {
    return JSON.parse(text);
  } catch (err) {
    return { success: false, error: 'bad_json', raw: text };
  }
}

module.exports = { createContext, call, formatDate, readSeed, ROOT, SRC, SEED };
