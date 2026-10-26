/**
 * server/gas-runtime.js — runs the SAME apps-script/src modules outside Apps Script.
 *
 * Why this exists: deploying a Google Apps Script web app needs an interactive browser
 * OAuth consent in the workshop's Google account, which cannot be scripted. This runtime
 * implements the Apps Script globals the backend actually uses — SpreadsheetApp,
 * CalendarApp, LockService, PropertiesService, ContentService, Utilities — on top of the
 * Google REST APIs, so the identical business logic runs behind
 * https://diyyourdata.com/workshop-api/ with no second implementation to drift.
 *
 * The Apps Script code is synchronous, so every Google call here is synchronous too:
 * curl is invoked through execFileSync. That costs ~15-30 ms per API round trip and is
 * the price of not maintaining two backends.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { requestSync } = require('./http-sync');

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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * Apps Script's Utilities.formatDate. Honours single-quoted literals ('T'), which is the
 * detail every reimplementation gets wrong: without it you emit 2026-11-05'T'08:00 and
 * every downstream new Date() is NaN.
 */
function formatDate(date, tz, pattern) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid time value');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'long', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;

  const tzName = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
  const offsetColon = tzName.replace('GMT', '') || '+00:00';
  const offsetCompact = offsetColon.replace(':', '');

  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekdayLong = get('weekday') || '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const pad = (n, w) => String(n).padStart(w, '0');

  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "'") {
      const end = pattern.indexOf("'", i + 1);
      out += end > -1 ? pattern.slice(i + 1, end) : pattern.slice(i + 1);
      i = end > -1 ? end + 1 : pattern.length;
      continue;
    }
    let matched = false;
    for (const [token, kind, style] of TOKEN_MAP) {
      if (!pattern.startsWith(token, i)) continue;
      switch (kind) {
        case 'year': out += String(year); break;
        case 'month':
          out += style === 'long' ? MONTHS[month - 1]
            : style === 'short' ? MONTHS[month - 1].slice(0, 3)
              : pad(month, 2);
          break;
        case 'day': out += style === '2' ? pad(day, 2) : String(day); break;
        case 'weekday': out += style === 'long' ? weekdayLong : weekdayLong.slice(0, 3); break;
        case 'hour': out += pad(hour, 2); break;
        case 'minute': out += pad(minute, 2); break;
        case 'second': out += pad(second, 2); break;
        case 'offset': out += offsetCompact; break;
        default: break;
      }
      i += token.length;
      matched = true;
      break;
    }
    if (!matched) { out += pattern[i]; i += 1; }
  }
  return out;
}

/* --------------------------------------------------------------- http (sync) --- */

const CURL = '/usr/bin/curl';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-api-'));

/** Synchronous HTTP through curl. Headers go via stdin config so the token never
 *  appears in the process list; the body goes through a 0600 temp file. */
function curlJson(method, url, body, headers) {
  const cfg = Object.entries(headers || {})
    .map(([k, v]) => `header = "${k.replace(/"/g, '')}: ${String(v).replace(/"/g, '')}"`)
    .join('\n');

  const args = ['-sS', '-X', method, '--max-time', '30', '-w', '\n%{http_code}', url];
  let bodyFile = null;
  if (body !== undefined && body !== null) {
    bodyFile = path.join(TMP, `body-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600 });
    args.push('--data-binary', `@${bodyFile}`);
  }
  args.push('-K', '-');

  let raw;
  try {
    raw = execFileSync(CURL, args, {
      input: cfg || '',
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 35000,
    });
  } catch (err) {
    if (err.stdout) raw = err.stdout;
    else throw new Error(`curl failed for ${method} ${url}: ${err.message}`);
  } finally {
    if (bodyFile) { try { fs.unlinkSync(bodyFile); } catch (e) { /* ignore */ } }
  }

  const cut = raw.lastIndexOf('\n');
  const status = Number(raw.slice(cut + 1)) || 0;
  const text = raw.slice(0, cut);
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (status >= 400) {
    const message = (json && (json.error?.message || json.error_description || json.message)) || text.slice(0, 300);
    const err = new Error(`${method} ${url} -> HTTP ${status}: ${message}`);
    err.status = status;
    err.body = json;
    throw err;
  }
  return json;
}

/* ---------------------------------------------------------------- google auth --- */

class GoogleAuth {
  constructor(tokenPath) {
    this.tokenPath = tokenPath;
    this.token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }

  accessToken() {
    const expiry = this.token.expiry ? new Date(this.token.expiry).getTime() : 0;
    if (this.token.access_token && expiry - Date.now() > 60_000) return this.token.access_token;
    if (!this.token.refresh_token) throw new Error('Google token has no refresh_token');
    if (!this.token.client_id || !this.token.client_secret) throw new Error('Google token has no client credentials');
    const body = new URLSearchParams({
      client_id: this.token.client_id,
      client_secret: this.token.client_secret,
      refresh_token: this.token.refresh_token,
      grant_type: 'refresh_token',
    }).toString();

    const json = requestSync('POST', 'https://oauth2.googleapis.com/token', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (!json.access_token) throw new Error(`token refresh failed: ${json.error || 'no access_token'}`);
    this.token.access_token = json.access_token;
    this.token.expiry = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();
    try { fs.writeFileSync(this.tokenPath, JSON.stringify(this.token, null, 2), { mode: 0o600 }); } catch (e) { /* read-only fs */ }
    return this.token.access_token;
  }

  request(method, url, body) {
    return requestSync(method, url, body, {
      Authorization: `Bearer ${this.accessToken()}`,
      'Content-Type': 'application/json',
    });
  }
}

/* -------------------------------------------------------------------- sheets --- */

class Range {
  constructor(sheet, row, col, numRows = 1, numCols = 1, prefetched = null) {
    Object.assign(this, { sheet, row, col, numRows, numCols, prefetched });
  }

  getValues() {
    // the header row is read on every append; cache it process-wide.
    // NOTE: only for a single-row range that is NOT a getDataRange() on a one-row tab -
    // and a cache hit must return the same nested shape as a miss, or callers that do
    // values[0].map() get a string of header cells instead of an array row.
    if (this.row === 1 && this.numRows === 1 && !this.prefetched) {
      const key = `header|${this.sheet.spreadsheet.id}|${this.sheet.name}`;
      const hit = READ_CACHE.get(key);
      if (hit && Date.now() - hit.ts < 300000) return [hit.values[0].slice(0, this.numCols)];
      const a1h = this.sheet.spreadsheet.a1(this.sheet.name, 1, 1, 1, this.numCols);
      const resh = this.sheet.spreadsheet.auth.request(
        'GET',
        `https://sheets.googleapis.com/v4/spreadsheets/${this.sheet.spreadsheet.id}/values/${encodeURIComponent(a1h)}` +
        '?valueRenderOption=UNFORMATTED_VALUE',
      );
      const hv = [(resh.values || [[]])[0] || []];
      READ_CACHE.set(key, { values: hv, ts: Date.now() });
      return hv.map((row) => row.slice(0, this.numCols));
    }

    // a range handed out from getDataRange() already has the tab in memory: no second fetch
    if (this.prefetched) {
      const out = [];
      for (let r = 0; r < this.numRows; r += 1) {
        const line = [];
        for (let c = 0; c < this.numCols; c += 1) {
          const row = this.prefetched[this.row - 1 + r] || [];
          line.push(row[this.col - 1 + c] === undefined ? '' : row[this.col - 1 + c]);
        }
        out.push(line);
      }
      return out;
    }

    const a1 = this.sheet.spreadsheet.a1(this.sheet.name, this.row, this.col, this.numRows, this.numCols);
    const res = this.sheet.spreadsheet.auth.request(
      'GET',
      `https://sheets.googleapis.com/v4/spreadsheets/${this.sheet.spreadsheet.id}/values/${encodeURIComponent(a1)}` +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING',
    );
    const got = res.values || [];
    const out = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const line = [];
      for (let c = 0; c < this.numCols; c += 1) {
        const row = got[r] || [];
        line.push(row[c] === undefined ? '' : row[c]);
      }
      out.push(line);
    }
    return out;
  }

  getValue() { return this.getValues()[0][0]; }

  setValue(value) {
    const a1 = `${quoteTab(this.sheet.name)}!R${this.row}C${this.col}`;
    this.sheet.spreadsheet.write(a1, [[value]]);
    return this;
  }

  setValues(values) {
    const a1 = `${quoteTab(this.sheet.name)}!R${this.row}C${this.col}`;
    this.sheet.spreadsheet.write(a1, values);
    return this;
  }

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

function colLetter(index) {
  let i = index;
  let s = '';
  while (i) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s || 'A';
}

function quoteTab(name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

class Sheet {
  constructor(spreadsheet, name) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this._values = null;
  }

  values() {
    if (!this._values) this._values = this.spreadsheet.read(this.name);
    return this._values;
  }

  invalidate() { this._values = null; }

  getDataRange() {
    const rows = this.values();
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0) || 1;
    return new Range(this, 1, 1, Math.max(rows.length, 1), width, rows);
  }

  getLastRow() { return this.values().length; }

  getLastColumn() { return this.values().reduce((m, r) => Math.max(m, r.length), 0); }

  getRange(row, col, numRows = 1, numCols = 1) { return new Range(this, row, col, numRows, numCols); }

  appendRow(values) {
    this.spreadsheet.append(this.name, [values]);
    this.invalidate();
  }

  getFilter() { return null; }
  setFrozenRows() {}
  setTabColor() {}
  setColumnWidth() {}
}

/**
 * Per-tab read cache, keyed sheetId|tab. TTLs are deliberate:
 *   - catalogue/config tabs change when the owner edits a price or a holiday, so a few
 *     seconds of staleness is fine and saves a 250 ms Sheets round trip on every call;
 *   - Customers / Vehicles / Bookings are transactional - always read fresh, because a
 *     stale Bookings read is how you double-book a bay.
 */
const READ_CACHE = new Map();
const CACHE_TTL_MS = {
  Config: 10000,
  Working_Hours: 10000,
  Holidays_Closures: 10000,
  Services: 10000,
  Products_Addons: 10000,
  README: 60000,
  // Customers and Vehicles are written rarely; a few seconds of staleness cannot
  // double-book anything (Bookings stays uncached for exactly that reason).
  Customers: 5000,
  Vehicles: 5000,
};

function cacheGet(sheetId, tab) {
  const ttl = CACHE_TTL_MS[tab];
  if (!ttl) return null;
  const hit = READ_CACHE.get(`${sheetId}|${tab}`);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) { READ_CACHE.delete(`${sheetId}|${tab}`); return null; }
  return hit.values;
}

function cacheSet(sheetId, tab, values) {
  if (!CACHE_TTL_MS[tab]) return;
  READ_CACHE.set(`${sheetId}|${tab}`, { values, ts: Date.now() });
}

function cacheClear(sheetId, tab) {
  READ_CACHE.delete(`${sheetId}|${tab}`);
}

/**
 * Date columns. The Sheets API returns a date cell as a serial number when you ask for
 * unformatted values, whereas Apps Script's getValues() hands back a Date. Converting here
 * keeps the backend code identical on both targets (and stops "2026-12-25" never matching
 * serial 46381, which silently disabled every holiday).
 */
const DATE_COLUMNS = {
  Holidays_Closures: ['date'],
  Vehicles: ['last_service_date'],
  Customers: ['first_seen', 'last_contact'],
  Bookings: ['created_at', 'start_datetime', 'end_datetime'],
  Call_Log: ['timestamp'],
};

function serialToDate(serial) {
  // Google Sheets epoch is 1899-12-30 (and the fraction is the time of day)
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400) * 1000);
}

function normaliseDates(tab, rows) {
  const cols = DATE_COLUMNS[tab];
  if (!cols || !rows.length) return rows;
  const header = (rows[0] || []).map((h) => String(h).trim());
  const indexes = cols.map((c) => header.indexOf(c)).filter((i) => i > -1);
  if (!indexes.length) return rows;
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    indexes.forEach((i) => {
      const v = row[i];
      if (typeof v === 'number' && v > 0 && v < 200000) row[i] = serialToDate(v);
    });
  }
  return rows;
}

class Spreadsheet {
  constructor(auth, id) {
    this.auth = auth;
    this.id = id;
    this.cache = new Map();
    this.bulk = null;
    this.dirty = new Set();
  }

  read(tab) {
    const cached = cacheGet(this.id, tab);
    if (cached) return cached;
    // UNFORMATTED_VALUE is what Apps Script's getValues() gives you. Without it the API
    // returns the display string ("$49.00") and every Number() downstream is NaN.
    const res = this.auth.request(
      'GET',
      `https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/${encodeURIComponent(quoteTab(tab))}` +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING',
    );
    const values = normaliseDates(tab, res.values || []);
    cacheSet(this.id, tab, values);
    return values;
  }

  write(a1, values) {
    const tabName = a1.split('!')[0].replace(/'/g, '');
    cacheClear(this.id, tabName);
    this.auth.request(
      'PUT',
      `https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`,
      { values },
    );
    this.dirty.add(a1.split('!')[0].replace(/'/g, ''));
    const sheet = this.cache.get(tabName);
    if (sheet) sheet.invalidate();
  }

  append(tab, rows) {
    cacheClear(this.id, tab);
    this.auth.request(
      'POST',
      `https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/${encodeURIComponent(quoteTab(tab))}:append` +
      '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      { values: rows },
    );
  }

  a1(tab, row, col, numRows, numCols) {
    const from = `${colLetter(col)}${row}`;
    const to = `${colLetter(col + numCols - 1)}${row + numRows - 1}`;
    return `${quoteTab(tab)}!${from}:${to}`;
  }

  getSheetByName(name) {
    if (!this.cache.has(name)) this.cache.set(name, new Sheet(this, name));
    return this.cache.get(name);
  }

  getId() { return this.id; }
}

/* ------------------------------------------------------------------ calendar --- */

class CalendarEvent {
  constructor(calendar, data) {
    this.calendar = calendar;
    this.data = data;
  }

  getId() { return this.data.id; }
  getTitle() { return this.data.summary || ''; }
  getStartTime() { return new Date(this.data.start.dateTime || this.data.start.date); }
  getEndTime() { return new Date(this.data.end.dateTime || this.data.end.date); }
  getDescription() { return this.data.description || ''; }
  isAllDay() { return Boolean(this.data.start.date && !this.data.start.dateTime); }

  setTime(start, end) {
    this.data = this.calendar.auth.request(
      'PATCH',
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendar.id)}/events/${this.data.id}`,
      { start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } },
    );
    return this;
  }

  setDescription(description) {
    this.data = this.calendar.auth.request(
      'PATCH',
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendar.id)}/events/${this.data.id}`,
      { description },
    );
    return this;
  }

  deleteEvent() {
    this.calendar.auth.request(
      'DELETE',
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendar.id)}/events/${this.data.id}`,
    );
  }
}

class Calendar {
  constructor(auth, id) {
    this.auth = auth;
    this.id = id;
  }

  createEvent(title, start, end, opts = {}) {
    const data = this.auth.request(
      'POST',
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.id)}/events`,
      {
        summary: title,
        description: opts.description || '',
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
        transparency: 'opaque',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
      },
    );
    return new CalendarEvent(this, data);
  }

  /**
   * Availability scanning asks for a day at a time, but every ask is a ~250 ms round trip.
   * So the first yes/no question pulls one wide window (yesterday .. +120 days) and later
   * questions are answered in memory. The window is per Calendar instance, and a Calendar
   * is created per request, so it is never stale across requests.
   */
  loadWindow() {
    if (this.window) return this.window;
    const from = new Date(Date.now() - 24 * 3600 * 1000);
    const to = new Date(Date.now() + 120 * 24 * 3600 * 1000);
    const res = this.auth.request(
      'GET',
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.id)}/events` +
      `?timeMin=${encodeURIComponent(from.toISOString())}` +
      `&timeMax=${encodeURIComponent(to.toISOString())}` +
      '&singleEvents=true&orderBy=startTime&maxResults=2500',
    );
    this.window = (res.items || [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => new CalendarEvent(this, e));
    return this.window;
  }

  getEvents(start, end) {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return this.loadWindow().filter((ev) => ev.getEndTime().getTime() > s && ev.getStartTime().getTime() < e);
  }

  getEventById(id) {
    const clean = String(id).replace(/@google\.com$/, '');
    try {
      const data = this.auth.request(
        'GET',
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.id)}/events/${encodeURIComponent(clean)}`,
      );
      return data && data.id ? new CalendarEvent(this, data) : null;
    } catch (err) {
      if (err.status === 404 || err.status === 410) return null;
      throw err;
    }
  }
}

/* ---------------------------------------------------------------- sandbox globals --- */

/**
 * Build the Apps Script global object for one request.
 * @param {object} env {sheetId, calendarId, sharedToken, googleTokenPath, extraProps}
 */
function createRuntime(env) {
  const auth = new GoogleAuth(env.googleTokenPath);
  const spreadsheet = new Spreadsheet(auth, env.sheetId);
  const calendars = new Map();
  calendars.set(env.calendarId, new Calendar(auth, env.calendarId));

  const props = new Map();
  if (env.sharedToken) props.set('SHARED_TOKEN', env.sharedToken);
  props.set('SHEET_ID', env.sheetId);
  Object.entries(env.extraProps || {}).forEach(([k, v]) => props.set(k, v));

  return {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, Intl, Set, Map,
    Utilities: { formatDate },
    Logger: { log: (...args) => console.log('[gas]', ...args) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
    },
    CalendarApp: {
      getCalendarById: (id) => calendars.get(id) || new Calendar(auth, id),
      getDefaultCalendar: () => calendars.get(env.calendarId),
    },
    LockService: {
      // Handlers run to completion synchronously on one event-loop tick, so requests
      // cannot interleave inside a write. The lock is still taken for API compatibility
      // and is the hook for a future multi-process deployment.
      getScriptLock: () => ({
        tryLock: () => true,
        hasLock: () => true,
        waitLock: () => {},
        releaseLock: () => {},
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
    HtmlService: new Proxy({}, { get: () => () => ({}) }),
  };
}

module.exports = { createRuntime, formatDate, curlJson, GoogleAuth };
