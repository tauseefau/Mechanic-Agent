#!/usr/bin/env node
/**
 * server/serve.js — serve the Apps Script backend over HTTP so it can live behind
 * https://diyyourdata.com/workshop-api/ without a Google Apps Script deployment.
 *
 * It compiles apps-script/src/*.js into a fresh vm context per request (so the
 * per-execution caches behave exactly like Apps Script: every request re-reads the
 * sheet, and an owner edit takes effect on the next call) and calls doPost/doGet.
 *
 * Endpoints (all on 127.0.0.1, fronted by the PHP bridge in
 * deploy/workshop-api/index.php):
 *   POST /            body = the same JSON Vapi sends ({"action":...,"token":...})
 *   GET  /?action=..  same
 *   GET  /health      liveness + Google connectivity probe (no token required)
 *
 * Env: PORT, SHEET_ID, CALENDAR_ID, SHARED_TOKEN, GOOGLE_TOKEN_PATH, LOG_LEVEL
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRuntime } = require('./gas-runtime');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'apps-script', 'src');
const MODULES = ['util.js', 'config.js', 'availability.js', 'customers.js', 'bookings.js', 'logging.js', 'api.js'];

const ENV = {
  port: Number(process.env.PORT || 8790),
  sheetId: process.env.SHEET_ID || '',
  calendarId: process.env.CALENDAR_ID || '',
  sharedToken: process.env.SHARED_TOKEN || '',
  googleTokenPath: process.env.GOOGLE_TOKEN_PATH || '/root/.hermes/google_token.json',
  logLevel: process.env.LOG_LEVEL || 'info',
};

function log(...args) {
  if (ENV.logLevel !== 'silent') console.log(new Date().toISOString(), ...args);
}

function fatal(msg) {
  console.error(`workshop-api: ${msg}`);
  process.exit(1);
}

if (!ENV.sheetId) fatal('SHEET_ID is required');
if (!ENV.calendarId) fatal('CALENDAR_ID is required');
if (!ENV.sharedToken) fatal('SHARED_TOKEN is required');
if (!fs.existsSync(ENV.googleTokenPath)) fatal(`Google token not found at ${ENV.googleTokenPath}`);

/* Modules are read once and hot-reloaded when the file changes on disk, so a git pull
 * plus a restart is not needed for a code tweak. */
const moduleCache = new Map();
function moduleSources() {
  const out = [];
  for (const file of MODULES) {
    const full = path.join(SRC, file);
    const stat = fs.statSync(full);
    const cached = moduleCache.get(file);
    if (!cached || cached.mtime !== stat.mtimeMs) {
      moduleCache.set(file, { mtime: stat.mtimeMs, source: fs.readFileSync(full, 'utf8') });
    }
    out.push([file, moduleCache.get(file).source]);
  }
  return out;
}

/** Fresh Apps Script context for one request. */
function loadContext() {
  const sandbox = createRuntime({
    sheetId: ENV.sheetId,
    calendarId: ENV.calendarId,
    sharedToken: ENV.sharedToken,
    googleTokenPath: ENV.googleTokenPath,
  });
  const context = vm.createContext(sandbox);
  for (const [file, source] of moduleSources()) {
    vm.runInContext(source, context, { filename: file, timeout: 30000 });
  }
  return context;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function collect(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const query = Object.fromEntries(url.searchParams.entries());

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    const started = Date.now();
    try {
      const context = loadContext();
      const info = vm.runInContext('getConfig_()', context);
      return json(res, 200, {
        ok: true,
        workshop: info.workshop_name,
        sheet_id: ENV.sheetId,
        calendar_id: ENV.calendarId,
        timezone: info.timezone,
        google_ms: Date.now() - started,
        modules: MODULES.length,
      });
    } catch (err) {
      return json(res, 503, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(res, 405, { success: false, error: 'method_not_allowed', message: 'Use POST.' });
  }

  let body = {};
  if (req.method === 'POST') {
    const raw = await collect(req);
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (err) {
      return json(res, 400, { success: false, error: 'bad_json', message: 'Body must be JSON.' });
    }
  }

  const started = Date.now();
  try {
    const context = loadContext();
    const event = { parameter: query, postData: { contents: JSON.stringify(body) }, headers: req.headers };
    const fn = req.method === 'GET' ? 'doGet' : 'doPost';
    const output = context[fn](event);
    const text = output && output.getContent ? output.getContent() : JSON.stringify(output);
    let payload;
    try { payload = JSON.parse(text); } catch (e) { payload = { success: false, error: 'bad_json', raw: String(text).slice(0, 400) }; }
    log(req.method, url.pathname, payload.action || body.action || '', payload.success ? 'ok' : (payload.error || 'fail'), `${Date.now() - started}ms`);
    return json(res, 200, payload);
  } catch (err) {
    log('ERROR', req.method, url.pathname, String(err && err.message ? err.message : err));
    return json(res, 200, {
      success: false,
      error: 'exception',
      detail: String(err && err.message ? err.message : err).slice(0, 400),
      stack: process.env.DEBUG_STACK === '1' ? String(err && err.stack).split('\n').slice(0, 8) : undefined,
      message: 'Sorry, I had trouble with that just now. Could you try that once more?',
    });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('UNHANDLED', String(err));
    if (!res.headersSent) json(res, 500, { success: false, error: 'server_error' });
  });
});

server.listen(ENV.port, '127.0.0.1', () => {
  log(`workshop-api listening on 127.0.0.1:${ENV.port}`, JSON.stringify({
    sheet: ENV.sheetId, calendar: ENV.calendarId, modules: MODULES.length,
  }));
});

process.on('SIGTERM', () => { log('SIGTERM, shutting down'); server.close(() => process.exit(0)); });
process.on('uncaughtException', (err) => log('uncaughtException', String(err && err.stack || err)));
process.on('unhandledRejection', (err) => log('unhandledRejection', String(err)));
