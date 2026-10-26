/**
 * util.js — shared helpers: sheet access, tab reading, timezone-safe date maths,
 * phone normalisation, JSON output.
 *
 * Runs unchanged in Apps Script and under the Node test harness (tests/harness).
 * Nothing here reads a business value: everything comes from the Config tab.
 */

var _SPREADSHEET = null;
var _TAB_CACHE = {};

/** The bound spreadsheet, or the one named by the SHEET_ID script property. */
function ss_() {
  if (_SPREADSHEET) return _SPREADSHEET;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  _SPREADSHEET = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_SPREADSHEET) throw new Error('No spreadsheet: bind the script or set SHEET_ID');
  return _SPREADSHEET;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab: ' + name);
  return sh;
}

/** Read a tab as an array of plain objects keyed by the header row. */
function readTab_(name) {
  if (_TAB_CACHE[name]) return _TAB_CACHE[name];
  var values = sheet_(name).getDataRange().getValues();
  if (!values.length) { _TAB_CACHE[name] = []; return []; }
  if (!Array.isArray(values[0])) {
    throw new Error('readTab_(' + name + '): expected rows of cells, got ' +
      typeof values[0] + ' — ' + String(JSON.stringify(values)).slice(0, 160));
  }
  var header = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row || row.join('') === '') continue;
    var obj = { _row: r + 1 };
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = row[c];
    }
    out.push(obj);
  }
  _TAB_CACHE[name] = out;
  return out;
}

function invalidateCache_(name) {
  if (name) { delete _TAB_CACHE[name]; } else { _TAB_CACHE = {}; }
}

/** 1-based column index for a header name, or -1. */
function columnIndex_(name, header) {
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim() === name) return i + 1;
  }
  return -1;
}

/** Header row. Bounded to 40 columns on purpose: getLastColumn() forces a full tab read,
 *  which on a growing Call_Log cost seconds per request over the REST runtime. */
function headerOf_(name) {
  return sheet_(name).getRange(1, 1, 1, 40).getValues()[0];
}

function appendObject_(tabName, obj) {
  var header = headerOf_(tabName);
  var row = header.map(function (h) { return obj[String(h).trim()] !== undefined ? obj[String(h).trim()] : ''; });
  sheet_(tabName).appendRow(row);
  invalidateCache_(tabName);
  return sheet_(tabName).getLastRow();
}

function setCell_(tabName, rowNumber, columnName, value) {
  var col = columnIndex_(columnName, headerOf_(tabName));
  if (col < 1) throw new Error('No column ' + columnName + ' on ' + tabName);
  sheet_(tabName).getRange(rowNumber, col, 1, 1).setValue(value);
  invalidateCache_(tabName);
}

/* ------------------------------------------------------------------ time --- */

function tz_() { return getConfig_().timezone || 'Australia/Melbourne'; }

/**
 * Build a real Date from a workshop-local wall clock date + time.
 * Works around Apps Script having no timezone-aware parser: guess UTC, read the
 * offset back out through Utilities.formatDate, correct once.
 */
function localDate_(dateStr, timeStr) {
  var tz = tz_();
  var naive = dateStr + 'T' + timeStr + ':00Z';
  var guess = new Date(naive);
  var shown = Utilities.formatDate(guess, tz, "yyyy-MM-dd'T'HH:mm");
  var offset = new Date(naive).getTime() - new Date(shown + ':00Z').getTime();
  return new Date(guess.getTime() + offset);
}

/** Accept 'yyyy-MM-dd HH:mm', ISO with Z/offset, or a Date. */
function parseWhen_(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  var s = String(value).trim();
  var m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) {
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && s.indexOf('T') > -1) {
      var d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
    return localDate_(m[1], m[2]);
  }
  var parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function addMinutes_(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function ymd_(date) { return Utilities.formatDate(date, tz_(), 'yyyy-MM-dd'); }
function hhmm_(date) { return Utilities.formatDate(date, tz_(), 'HH:mm'); }
function weekdayName_(date) { return Utilities.formatDate(date, tz_(), 'EEEE'); }
/**
 * ISO 8601 with the workshop's UTC offset, e.g. 2026-11-23T14:00:00+11:00.
 * An offset-less timestamp is ambiguous to every downstream consumer (Vapi tool
 * results, the owner reading the Bookings tab), so the offset is always included.
 */
function iso_(date) {
  var base = Utilities.formatDate(date, tz_(), "yyyy-MM-dd'T'HH:mm:ssZ");
  var m = base.match(/([+-]\d{2})(\d{2})$/);
  if (!m) return base;
  return base.substring(0, base.length - 5) + m[1] + ':' + m[2];
}

function minutesOfDay_(date) {
  return Number(Utilities.formatDate(date, tz_(), 'HH')) * 60 + Number(Utilities.formatDate(date, tz_(), 'mm'));
}

/** 'HH:MM' -> minutes since midnight. */
function parseClock_(value) {
  if (value === null || value === undefined || value === '') return null;
  var s = String(value).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* --------------------------------------------------------------- phones --- */

/** Normalise any AU-ish input to E.164 (+61412345678). Returns '' when hopeless. */
function normalisePhone_(input) {
  var cfg = getConfig_();
  var cc = String(cfg.phone_country_code || '61');
  var raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return '';
  var plus = raw.charAt(0) === '+';
  var digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (plus) return '+' + digits;
  if (digits.indexOf('00') === 0) return '+' + digits.substring(2);
  if (digits.charAt(0) === '0') {
    var national = digits.replace(/^0+/, '');
    return '+' + cc + national;
  }
  if (digits.indexOf(cc) === 0 && digits.length >= cc.length + 8) return '+' + digits;
  if (digits.length === 9) return '+' + cc + digits;
  return digits.length >= 8 ? '+' + digits : '';
}

function isValidPhone_(phone) { return /^\+\d{8,15}$/.test(String(phone || '')); }

/* ------------------------------------------------------------------ out --- */

function jsonOut_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function money_(n, cfg) {
  cfg = cfg || getConfig_();
  var symbol = cfg.currency_symbol || '$';
  var rounded = Math.round(Number(n || 0));
  return symbol + rounded;
}

function priceRange_(low, high, cfg) {
  cfg = cfg || getConfig_();
  low = Number(low || 0); high = Number(high || low);
  if (Math.round(low) === Math.round(high)) return money_(low, cfg);
  return money_(low, cfg) + ' to ' + money_(high, cfg);
}

function roundUpTo_(date, minutes) {
  var ms = minutes * 60000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}
