#!/usr/bin/env node
/**
 * scripts/reset-data.js — put the workshop back to a clean, pre-go-live state.
 *
 * Clears Bookings and Call_Log, removes every test customer/vehicle, and deletes the
 * booking events from the Workshop Bookings calendar. The Config, Services,
 * Products_Addons, Working_Hours and Holidays_Closures tabs are never touched.
 *
 *   node scripts/reset-data.js            # dry run: show what would go
 *   node scripts/reset-data.js --apply    # do it
 *
 * Env: GOOGLE_TOKEN_PATH (default ~/.hermes/google_token.json), SHEET_ID, CALENDAR_ID
 * (both default to .env in the repo root).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('../server/gas-runtime');

const ROOT = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

function envValue(name, fallback = '') {
  if (process.env[name]) return process.env[name];
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].replace(/^"|"$/g, '').trim() : fallback;
  } catch (e) { return fallback; }
}

const SHEET_ID = envValue('SHEET_ID');
const CALENDAR_ID = envValue('CALENDAR_ID');
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || path.join(process.env.HOME || '/root', '.hermes', 'google_token.json');

const KEEP_CUSTOMERS = ['CUS0001', 'CUS0002'];   // the obviously-fake sample rows
const KEEP_VEHICLES = ['VEH0001', 'VEH0002'];

if (!SHEET_ID || !CALENDAR_ID) {
  console.error('SHEET_ID and CALENDAR_ID are required');
  process.exit(2);
}

const auth = new GoogleAuth(TOKEN_PATH);
const sheetBase = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

function readTab(tab) {
  const res = auth.request('GET', `${sheetBase}/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  return res.values || [];
}

function clearRange(range) {
  auth.request('POST', `${sheetBase}/values/${encodeURIComponent(range)}:clear`, {});
}

function appendRows(tab, rows) {
  if (!rows.length) return;
  auth.request('POST', `${sheetBase}/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
}

const bookings = readTab('Bookings');
const logs = readTab('Call_Log');
const customers = readTab('Customers');
const vehicles = readTab('Vehicles');

const killCustomers = customers.slice(1).filter((r) => r[0] && !KEEP_CUSTOMERS.includes(String(r[0])));
const killVehicles = vehicles.slice(1).filter((r) => r[0] && !KEEP_VEHICLES.includes(String(r[0])));
const keepCustomerRows = customers.slice(1).filter((r) => r[0] && KEEP_CUSTOMERS.includes(String(r[0])));
const keepVehicleRows = vehicles.slice(1).filter((r) => r[0] && KEEP_VEHICLES.includes(String(r[0])));

let events = [];
try {
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date(Date.now() + 200 * 86400000).toISOString();
  const res = auth.request('GET', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&maxResults=2500`);
  events = res.items || [];
} catch (err) {
  console.error('calendar read failed:', err.message);
}

console.log(`Bookings rows:   ${Math.max(bookings.length - 1, 0)}`);
console.log(`Call_Log rows:   ${Math.max(logs.length - 1, 0)}`);
console.log(`Customers to remove: ${killCustomers.length} (keeping ${KEEP_CUSTOMERS.join(', ')})`);
console.log(`Vehicles to remove:  ${killVehicles.length}`);
console.log(`Calendar events to delete: ${events.length}`);

if (!APPLY) {
  console.log('\ndry run — re-run with --apply to execute');
  process.exit(0);
}

clearRange('Bookings!A2:Z');
clearRange('Call_Log!A2:Z');
clearRange('Customers!A2:Z');
clearRange('Vehicles!A2:Z');

appendRows('Customers', keepCustomerRows);
appendRows('Vehicles', keepVehicleRows);

for (const ev of events) {
  try {
    auth.request('DELETE', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(ev.id)}`);
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) console.error(`  event ${ev.id}: ${err.message}`);
  }
}

console.log('\nreset complete');
