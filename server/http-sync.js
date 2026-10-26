/**
 * server/http-sync.js — synchronous HTTPS for the Apps Script modules.
 *
 * The modules call Google like Apps Script does: getValues(), appendRow(), createEvent().
 * All of it blocks. So this module blocks the caller on a SharedArrayBuffer while a
 * worker thread (server/http-worker.js) performs the request with a pooled connection.
 *
 * Falls back to a subprocess curl if the worker is unavailable, so a broken worker
 * degrades latency rather than the service.
 */
'use strict';

const { Worker } = require('worker_threads');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-http-'));
const sab = new SharedArrayBuffer(4);
const flag = new Int32Array(sab);
const TIMEOUT_MS = 30000;

let worker = null;
let workerFailed = false;
let seq = 0;

function ensureWorker() {
  if (worker || workerFailed) return;
  try {
    worker = new Worker(path.join(__dirname, 'http-worker.js'), { workerData: { sab } });
    worker.on('error', (err) => {
      console.error('http-sync worker error:', err && err.message);
      workerFailed = true;
      worker = null;
    });
    worker.on('exit', () => { worker = null; });
    worker.unref();
  } catch (err) {
    console.error('http-sync: cannot start worker, falling back to curl:', err && err.message);
    workerFailed = true;
  }
}

function viaWorker(method, url, body, headers) {
  seq += 1;
  const id = `${process.pid}-${seq}`;
  const reqFile = path.join(TMP, `req-${id}.json`);
  const resFile = path.join(TMP, `res-${id}.json`);
  fs.writeFileSync(reqFile, JSON.stringify({ method, url, body, headers }), { mode: 0o600 });

  Atomics.store(flag, 0, 0);
  worker.postMessage({ id, req: reqFile, res: resFile });
  const result = Atomics.wait(flag, 0, 0, TIMEOUT_MS);

  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (e) { payload = null; }
  try { fs.unlinkSync(reqFile); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(resFile); } catch (e) { /* ignore */ }

  if (result === 'timed-out' || !payload) {
    const err = new Error(`request timeout after ${TIMEOUT_MS}ms: ${method} ${url}`);
    err.status = 0;
    throw err;
  }
  if (payload.error) {
    const err = new Error(`network error for ${method} ${url}: ${payload.error}`);
    err.status = 0;
    throw err;
  }
  return payload;
}

function viaCurl(method, url, body, headers) {
  const cfg = Object.entries(headers || {})
    .map(([k, v]) => `header = "${k.replace(/"/g, '')}: ${String(v).replace(/"/g, '')}"`)
    .join('\n');
  const args = ['-sS', '-X', method, '--max-time', '30', '-w', '\n%{http_code}', url, '-K', '-'];
  let raw;
  try {
    raw = execFileSync('/usr/bin/curl', args, {
      input: `${cfg}\n${body ? `data-binary = ${JSON.stringify(JSON.stringify(body))}\n` : ''}`,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 35000,
    });
  } catch (err) {
    if (!err.stdout) throw new Error(`curl failed: ${err.message}`);
    raw = err.stdout;
  }
  const cut = raw.lastIndexOf('\n');
  const status = Number(raw.slice(cut + 1)) || 0;
  const text = raw.slice(0, cut);
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = { raw: text }; }
  return { status, body: parsed };
}

/** Block without a busy loop. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Google's 429 is a per-minute quota, so a short retry lands in the same window and
 *  fails again. These delays straddle the minute boundary; production traffic is far
 *  below the quota, so this only really fires when a test suite hammers the API. */
const RETRY_DELAYS_MS = [1500, 4000];

/**
 * Synchronous JSON request. Throws on >= 400 with the API's message attached.
 * Google returns 429 for per-minute quota bursts (a full test suite can trip it); retrying
 * in-process is better than surfacing "I had trouble with that" to a caller mid-booking.
 */
function requestSync(method, url, body, headers) {
  ensureWorker();
  let payload;
  for (let attempt = 0; ; attempt += 1) {
    payload = (worker && !workerFailed)
      ? viaWorker(method, url, body, headers)
      : viaCurl(method, url, body, headers);
    if (!RETRY_STATUSES.has(payload.status) || attempt >= RETRY_DELAYS_MS.length) break;
    sleepSync(RETRY_DELAYS_MS[attempt]);
  }

  const { status } = payload;
  const json = payload.body;
  if (status >= 400) {
    const message = (json && (json.error?.message || json.error_description || json.message)) || 'request failed';
    const err = new Error(`${method} ${url} -> HTTP ${status}: ${message}`);
    err.status = status;
    err.body = json;
    throw err;
  }
  return json;
}

module.exports = { requestSync };
