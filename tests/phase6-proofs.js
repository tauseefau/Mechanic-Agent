#!/usr/bin/env node
/**
 * tests/phase6-proofs.js — the "owner never touches code" proofs, against the LIVE sheet
 * and the LIVE deployed endpoint.
 *
 * Three edits an owner would make in the spreadsheet, each verified through the same
 * HTTPS endpoint Vapi calls, then reverted:
 *
 *   A. add a product/add-on row          -> list_services shows it, a quote includes it
 *   B. change a service price            -> get_price_quote returns the new range
 *   C. change Monday's opening time      -> check_availability starts at the new time
 *
 * The catalogue tabs are cached for 10 s in the running service (server/gas-runtime.js),
 * so every assertion polls for up to 25 s instead of pretending the change is instant.
 * That cache window is itself part of the behaviour being proven.
 *
 * Usage
 *   node tests/phase6-proofs.js            # run all three, revert, report
 *   node tests/phase6-proofs.js --keep     # leave the edits in place
 *
 * Exit code 0 = every assertion passed and every edit was reverted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('../server/gas-runtime');

const ROOT = path.resolve(__dirname, '..');
const ENV = (() => {
  try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return ''; }
})();

function env(name, fallback = '') {
  if (process.env[name]) return process.env[name];
  const m = ENV.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].replace(/^"|"$/g, '').trim() : fallback;
}

const SHEET_ID = env('SHEET_ID');
const TOKEN = env('APPS_SCRIPT_SHARED_TOKEN');
const URL_ = env('APPS_SCRIPT_WEBAPP_URL');
const TOKEN_PATH = env('GOOGLE_TOKEN_PATH', path.join(process.env.HOME || '/root', '.hermes', 'google_token.json'));
const KEEP = process.argv.includes('--keep');

if (!SHEET_ID || !TOKEN || !URL_) {
  console.error('SHEET_ID, APPS_SCRIPT_SHARED_TOKEN and APPS_SCRIPT_WEBAPP_URL are required');
  process.exit(2);
}

const auth = new GoogleAuth(TOKEN_PATH);
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  (${detail})` : '') : `\n        ${detail}`}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function call(action, params = {}, budgetMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const res = await fetch(`${URL_}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token: TOKEN, ...params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  } finally { clearTimeout(timer); }
}

function readTab(tab) {
  const res = auth.request('GET', `${SHEETS}/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  return res.values || [];
}
function putCell(range, value) {
  auth.request('PUT', `${SHEETS}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: [[value]] });
}
function appendRow(tab, row) {
  auth.request('POST', `${SHEETS}/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] });
}
function sheetGid(title) {
  const meta = auth.request('GET', `${SHEETS}?fields=sheets.properties`);
  const hit = (meta.sheets || []).find((s) => s.properties && s.properties.title === title);
  return hit ? hit.properties.sheetId : null;
}
function deleteRow(tab, rowIndex1Based) {
  const gid = sheetGid(tab);
  if (gid === null) throw new Error(`no sheet named ${tab}`);
  auth.request('POST', `${SHEETS}:batchUpdate`, {
    requests: [{
      deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based } },
    }],
  });
}

/** Poll an assertion so the 10 s catalogue cache cannot create a false failure. */
async function eventually(label, fn, budgetMs = 25000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < budgetMs) {
    try {
      const out = await fn();
      if (out) return { ok: true, value: out, waited: Date.now() - started };
    } catch (err) { last = err.message; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: not true after ${budgetMs / 1000}s${last ? ` (${last})` : ''}`);
}

function rowOf(tab, col, value) {
  const rows = readTab(tab);
  for (let i = 1; i < rows.length; i += 1) {
    if (String(rows[i][col]) === String(value)) return { row: i + 1, values: rows[i] };
  }
  return null;
}

const ADDON_ID = 'ADD900';
const ADDON_NAME = 'Headlight globe replacement';

async function proofAddon() {
  console.log('\nA. Owner adds a product/add-on row');
  const before = await call('list_services');
  assert(before.success, 'list_services failed');
  assert(!before.addons.some((a) => a.item_id === ADDON_ID), `${ADDON_ID} already present before the test`);
  assert(!before.addons.some((a) => a.item_name === ADDON_NAME), `${ADDON_NAME} already present before the test`);

  appendRow('Products_Addons', [ADDON_ID, ADDON_NAME, 'Parts', 60, 15, '', true, 'PHASE 6 proof row - removed automatically']);
  let appendedRow = null;
  try {
    const seen = await eventually('add-on visible to the agent', async () => {
      const r = await call('list_services');
      return r.addons.find((a) => a.item_id === ADDON_ID) || null;
    });
    record('add-on appears in list_services with no code change', true,
      `${seen.value.item_name} $${seen.value.price}, ${seen.waited / 1000}s after the edit`);

    const quote = await eventually('quote includes the new add-on', async () => {
      const r = await call('get_price_quote', { service_id: 'SVC002', addon_ids: [ADDON_ID] });
      return r.success && r.price_low === 240 && r.price_high === 320 ? r : null;
    });
    record('quote includes the new add-on', true, `$${quote.value.price_low} to $${quote.value.price_high}, duration ${quote.value.duration_minutes} min`);
  } finally {
    const found = rowOf('Products_Addons', 0, ADDON_ID);
    appendedRow = found ? found.row : null;
    if (appendedRow && !KEEP) deleteRow('Products_Addons', appendedRow);
  }
  if (!KEEP) {
    const gone = await eventually('add-on removed again', async () => {
      const r = await call('list_services');
      return !r.addons.some((a) => a.item_id === ADDON_ID);
    });
    record('proof row removed, catalogue back to the owner\'s state', true, `${gone.waited / 1000}s to expire out of cache`);
  }
}

async function proofPrice() {
  console.log('\nB. Owner changes a price');
  const svc = rowOf('Services', 0, 'SVC002');
  assert(svc, 'SVC002 not found in Services');
  const origLow = Number(svc.values[4]);
  const origHigh = Number(svc.values[5]);
  const newLow = origLow + 15;
  const newHigh = origHigh + 15;
  console.log(`    Minor Service ${origLow}-${origHigh} -> ${newLow}-${newHigh} (Services!E${svc.row}:F${svc.row})`);

  putCell(`Services!E${svc.row}`, newLow);
  putCell(`Services!F${svc.row}`, newHigh);
  try {
    const quoted = await eventually('quote reflects the new price', async () => {
      const r = await call('get_price_quote', { service_id: 'SVC002' });
      return r.success && r.price_low === newLow && r.price_high === newHigh ? r : null;
    });
    record('get_price_quote returns the edited range', true, `${quoted.value.price_range}, ${quoted.waited / 1000}s after the edit`);

    const listed = await eventually('list_services reflects the new price', async () => {
      const r = await call('list_services');
      const s = r.services.find((x) => x.service_id === 'SVC002');
      return s && s.price_from === newLow && s.price_to === newHigh ? s : null;
    });
    record('list_services returns the edited range', true, listed.value.price_range);
  } finally {
    if (!KEEP) { putCell(`Services!E${svc.row}`, origLow); putCell(`Services!F${svc.row}`, origHigh); }
  }
  if (!KEEP) {
    const back = await eventually('price restored', async () => {
      const r = await call('get_price_quote', { service_id: 'SVC002' });
      return r.success && r.price_low === origLow && r.price_high === origHigh ? r : null;
    });
    record('price reverted, no residue', true, back.value.price_range);
  }
}

async function proofHours() {
  console.log('\nC. Owner changes Monday opening time');
  const mon = rowOf('Working_Hours', 0, 'Monday');
  assert(mon, 'Monday row not found in Working_Hours');
  const origOpen = String(mon.values[1]);
  const newOpen = origOpen === '09:00' ? '09:30' : '09:00';
  // a Monday far enough ahead to pass the 4 h lead time and sit inside max_days_ahead
  const monday = (() => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const base = new Date(`${parts}T12:00:00Z`);
    for (let i = 3; i < 25; i += 1) {
      const d = new Date(base.getTime() + i * 86400000);
      if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
    }
    throw new Error('no Monday found');
  })();
  console.log(`    Monday open ${origOpen} -> ${newOpen} (Working_Hours!B${mon.row}), checking ${monday}`);

  putCell(`Working_Hours!B${mon.row}`, newOpen);
  try {
    const slot = await eventually('availability starts at the new opening time', async () => {
      const r = await call('check_availability', { service_id: 'SVC002', preferred_date: monday, time_preference: 'any' });
      if (!r.success || !r.slots || !r.slots.length) return null;
      const first = r.slots[0].start_datetime.slice(11, 16);
      return first === newOpen ? r : null;
    }, 40000);
    record('check_availability honours the edited opening time', true, `${monday} first slot ${slot.value.slots[0].start_datetime}, ${slot.waited / 1000}s after the edit`);
  } finally {
    if (!KEEP) putCell(`Working_Hours!B${mon.row}`, origOpen);
  }
  if (!KEEP) {
    const back = await eventually('opening time restored', async () => {
      const r = await call('check_availability', { service_id: 'SVC002', preferred_date: monday, time_preference: 'any' });
      return r.success && r.slots && r.slots[0] && r.slots[0].start_datetime.slice(11, 16) === origOpen ? r : null;
    }, 40000);
    record('opening time reverted, no residue', true, `first slot back to ${back.value.slots[0].start_datetime.slice(11, 16)}`);
  }
}

(async () => {
  console.log(`Phase 6 no-code-change proofs against ${URL_}`);
  try { await proofAddon(); } catch (err) { record('A. add-on row', false, err.message); }
  try { await proofPrice(); } catch (err) { record('B. price change', false, err.message); }
  try { await proofHours(); } catch (err) { record('C. opening hours change', false, err.message); }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} assertions passed`);
  if (pass !== results.length) process.exitCode = 1;
})();
