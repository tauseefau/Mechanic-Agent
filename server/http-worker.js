/**
 * server/http-worker.js — performs one HTTPS request per message, off the main thread.
 *
 * The Apps Script modules are synchronous, so the main thread has to block while Google
 * answers. Doing that with `curl` costs a fresh process AND a fresh TLS handshake per
 * call (~300 ms); with ten calls in a booking that is seconds of dead air on a phone
 * call. This worker keeps Node's fetch connection pool alive, so the warm cost is
 * ~25-40 ms per call instead.
 */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const flag = new Int32Array(workerData.sab);

parentPort.on('message', async ({ req, res }) => {
  let payload;
  try {
    const spec = JSON.parse(fs.readFileSync(req, 'utf8'));
    const init = { method: spec.method, headers: spec.headers || {} };
    if (spec.body !== undefined && spec.body !== null) {
      init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    }
    const response = await fetch(spec.url, init);
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
    payload = { status: response.status, body };
  } catch (err) {
    payload = { status: 0, error: String(err && err.message ? err.message : err) };
  }
  try {
    fs.writeFileSync(res, JSON.stringify(payload));
  } catch (e) {
    /* the main thread will time out and surface an error */
  }
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
