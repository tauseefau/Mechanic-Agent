#!/usr/bin/env node
/**
 * tests/api-tests.js — exercises every Apps Script action through the real doPost/doGet
 * path, either
 *
 *   (a) against the Node harness (default) — no deployment needed, and
 *   (b) against a live deployment when --live is passed (needs APPS_SCRIPT_WEBAPP_URL
 *       and APPS_SCRIPT_SHARED_TOKEN).
 *
 * Usage
 *   node tests/api-tests.js                     # harness run, full suite
 *   node tests/api-tests.js --live              # live run
 *   node tests/api-tests.js --filter booking    # only tests whose name matches
 *
 * Exit code 0 = every test passed.
 */
'use strict';

const { createContext, call } = require('./harness/gas');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const paceIdx = args.indexOf('--pace');
// live runs share Google's 300 reads/minute quota, so pace them by default
const PACE_MS = paceIdx > -1 ? Number(args[paceIdx + 1]) : (LIVE ? 2000 : 0);
const filterIdx = args.indexOf('--filter');
const FILTER = filterIdx > -1 ? args[filterIdx + 1] : null;
// --slice 1:20 runs only tests 1-20. Google's Sheets quota is 60 reads/minute PER USER,
// so a full live run has to be split into batches with a pause between them.
const sliceIdx = args.indexOf('--slice');
const SLICE = sliceIdx > -1 ? String(args[sliceIdx + 1]).split(':').map(Number) : null;
let testIndex = 0;
const URL = process.env.APPS_SCRIPT_WEBAPP_URL || '';
const TOKEN = process.env.APPS_SCRIPT_SHARED_TOKEN || '';

const results = [];
let ctx = null;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
}

async function test(name, fn) {
  testIndex += 1;
  if (SLICE && (testIndex < SLICE[0] || testIndex > (SLICE[1] || SLICE[0]))) return;
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  if (PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS));
  try {
    const detail = await fn();
    record(name, true, detail || '');
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* --------------------------------------------------------------- live mode --- */

async function callLive(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

const POST = LIVE ? callLive : async (body) => call(ctx, body);

/* ------------------------------------------------------------------ helpers --- */

const TZ = 'Australia/Melbourne';

function melbourne(offsetDays) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const base = new Date(`${parts}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

function nextWeekday(minDaysAhead) {
  for (let i = minDaysAhead; i < minDaysAhead + 14; i += 1) {
    const d = melbourne(i);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return d;
  }
  throw new Error('no weekday found');
}

function nextSaturday() {
  for (let i = 2; i < 20; i += 1) {
    const d = melbourne(i);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 6) return d;
  }
  throw new Error('no saturday found');
}

const SAMPLE_PHONE = '+61400000001';

/* -------------------------------------------------------------------- suite --- */

(async () => {
  if (LIVE) {
    if (!URL || !TOKEN) {
      console.error('--live needs APPS_SCRIPT_WEBAPP_URL and APPS_SCRIPT_SHARED_TOKEN');
      process.exit(2);
    }
    console.log(`live target: ${URL}\n`);
  } else {
    ctx = createContext();
  }

  /* --- auth & routing --- */
  await test('ping works with a valid token', async () => {
    const r = await POST({ action: 'ping', token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
  });

  await test('rejects a request with no token', async () => {
    if (LIVE) {
      const res = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ping' }), redirect: 'follow',
      });
      const r = JSON.parse(await res.text());
      assert(r.success === false && r.error === 'unauthorised', JSON.stringify(r));
      return;
    }
    const r = call(ctx, { action: 'ping' }, { token: null });
    assert(r.success === false && r.error === 'unauthorised', JSON.stringify(r));
  });

  await test('rejects a wrong token', async () => {
    if (LIVE) {
      const r = await callLive({ action: 'ping', token: 'wrong-token' });
      assert(r.success === false, JSON.stringify(r));
      return;
    }
    const r = call(ctx, { action: 'ping' }, { token: 'nope' });
    assert(r.success === false && r.error === 'unauthorised', JSON.stringify(r));
  });

  await test('unknown action returns a speakable failure', async () => {
    const r = await POST({ action: 'do_something_else', token: LIVE ? TOKEN : undefined });
    assert(r.success === false && r.error === 'unknown_action' && r.message, JSON.stringify(r));
  });

  await test('GET works the same as POST', async () => {
    if (LIVE) return;
    const r = call(ctx, { action: 'ping' }, { asGet: true });
    assert(r.success === true, JSON.stringify(r));
  });

  /* --- get_workshop_info --- */
  await test('get_workshop_info returns hours, address, currency', async () => {
    const r = await POST({ action: 'get_workshop_info', token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    const w = r.workshop;
    assert(w.workshop_name, 'no workshop_name');
    assert(w.hours.length === 7, `expected 7 weekday rows, got ${w.hours.length}`);
    assert(w.timezone === TZ, `timezone ${w.timezone}`);
    assert(w.currency === 'AUD', `currency ${w.currency}`);
    assert(/open/i.test(r.message), 'message should mention opening hours');
  });

  await test('get_workshop_info lists closures with a reason', async () => {
    const r = await POST({ action: 'get_workshop_info', token: LIVE ? TOKEN : undefined });
    const xmas = r.workshop.closures.find((c) => c.date === '2026-12-25');
    assert(xmas && /christmas/i.test(xmas.reason), 'Christmas closure missing');
  });

  /* --- list_services --- */
  await test('list_services returns 3 services and 6 add-ons', async () => {
    const r = await POST({ action: 'list_services', token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(r.services.length === 3, `services: ${r.services.length}`);
    assert(r.addons.length === 6, `addons: ${r.addons.length}`);
    const minor = r.services.find((s) => s.service_id === 'SVC002');
    assert(minor.price_from === 180 && minor.price_to === 260, JSON.stringify(minor));
    assert(minor.duration_minutes === 90, 'minor duration');
  });

  /* --- get_price_quote --- */
  await test('get_price_quote quotes the service range', async () => {
    const r = await POST({ action: 'get_price_quote', service_id: 'SVC002', token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(r.price_low === 180 && r.price_high === 260, `${r.price_low}-${r.price_high}`);
    assert(r.duration_minutes === 90, `duration ${r.duration_minutes}`);
    assert(/\$180/.test(r.message) && /\$260/.test(r.message), r.message);
  });

  await test('get_price_quote adds add-on price and duration', async () => {
    const r = await POST({ action: 'get_price_quote', service_id: 'SVC002', addon_ids: ['ADD004'], token: LIVE ? TOKEN : undefined });
    assert(r.price_low === 460, `low ${r.price_low}`);
    assert(r.price_high === 540, `high ${r.price_high}`);
    assert(r.duration_minutes === 180, `duration ${r.duration_minutes}`);
    assert(r.addons.length === 1, 'addon not applied');
  });

  await test('get_price_quote with three add-ons sums correctly', async () => {
    const r = await POST({ action: 'get_price_quote', service_id: 'SVC003', addon_ids: ['ADD004', 'ADD005', 'ADD006'], token: LIVE ? TOKEN : undefined });
    assert(r.price_low === 480 + 280 + 55 + 65, `low ${r.price_low}`);
    assert(r.duration_minutes === 240 + 90 + 15 + 20, `duration ${r.duration_minutes}`);
  });

  await test('get_price_quote ignores an unknown add-on but reports it', async () => {
    const r = await POST({ action: 'get_price_quote', service_id: 'SVC002', addon_ids: ['ADD999'], token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(r.price_low === 180, 'unknown add-on changed the price');
    assert(r.unknown_addons.length === 1, 'unknown add-on not reported');
  });

  await test('get_price_quote rejects an unknown service', async () => {
    const r = await POST({ action: 'get_price_quote', service_id: 'SVC999', token: LIVE ? TOKEN : undefined });
    assert(r.success === false && r.error === 'unknown_service', JSON.stringify(r));
  });

  /* --- lookup_customer --- */
  await test('lookup_customer recognises a known number', async () => {
    const r = await POST({ action: 'lookup_customer', phone: SAMPLE_PHONE, token: LIVE ? TOKEN : undefined });
    assert(r.success === true && r.known === true, JSON.stringify(r));
    assert(r.customer.full_name === 'Sample Customer', r.customer.full_name);
    assert(r.vehicles.length === 1 && r.vehicles[0].rego === 'ABC123', JSON.stringify(r.vehicles));
    assert(/welcome back/i.test(r.message), r.message);
  });

  await test('lookup_customer normalises a local 04 number', async () => {
    const r = await POST({ action: 'lookup_customer', phone: '0400 000 001', token: LIVE ? TOKEN : undefined });
    assert(r.known === true, JSON.stringify(r));
  });

  await test('lookup_customer reports a new customer for an unknown number', async () => {
    const r = await POST({ action: 'lookup_customer', phone: '+61499887766', token: LIVE ? TOKEN : undefined });
    assert(r.success === true && r.known === false, JSON.stringify(r));
    assert(/new customer/i.test(r.message), r.message);
  });

  await test('lookup_customer rejects an invalid phone', async () => {
    const r = await POST({ action: 'lookup_customer', phone: '12345', token: LIVE ? TOKEN : undefined });
    assert(r.success === false && r.error === 'invalid_phone', JSON.stringify(r));
  });

  /* --- check_availability --- */
  await test('check_availability returns 3 slots inside opening hours', async () => {
    const date = nextWeekday(5);
    const r = await POST({ action: 'check_availability', service_id: 'SVC002', preferred_date: date, token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(r.slots.length === 3, `slots ${r.slots.length}`);
    for (const s of r.slots) {
      const hhmm = s.start_datetime.slice(11, 16);
      assert(hhmm >= '08:00' && hhmm < '17:00', `outside hours: ${s.start_datetime}`);
      assert(!(hhmm >= '12:00' && hhmm < '12:30'), `slot inside lunch: ${s.start_datetime}`);
    }
    assert(/Which one suits/.test(r.message), r.message);
  });

  await test('check_availability morning preference only offers mornings', async () => {
    const r = await POST({ action: 'check_availability', service_id: 'SVC001', preferred_date: nextWeekday(5), time_preference: 'morning', token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    for (const s of r.slots) assert(s.start_datetime.slice(11, 16) < '12:00', s.start_datetime);
  });

  await test('check_availability names the closure and does not offer it', async () => {
    const r = await POST({ action: 'check_availability', service_id: 'SVC002', preferred_date: '2026-12-25', token: LIVE ? TOKEN : undefined });
    assert((r.slots || []).every((s) => !s.start_datetime.startsWith('2026-12-25')), 'offered a slot on Christmas Day');
    assert(/christmas/i.test(r.message), r.message);
  });

  await test('check_availability moves past a closed Sunday', async () => {
    let sunday = null;
    for (let i = 3; i < 20; i += 1) {
      const d = melbourne(i);
      if (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) { sunday = d; break; }
    }
    const r = await POST({ action: 'check_availability', service_id: 'SVC001', preferred_date: sunday, token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(!r.slots[0].start_datetime.startsWith(sunday), 'offered a slot on a closed Sunday');
  });

  await test('check_availability respects Saturday short hours', async () => {
    const sat = nextSaturday();
    const r = await POST({ action: 'check_availability', service_id: 'SVC002', preferred_date: sat, token: LIVE ? TOKEN : undefined });
    if (r.success) {
      for (const s of r.slots) {
        assert(s.start_datetime.slice(0, 10) !== sat || s.end_datetime.slice(11, 16) <= '12:00',
          `beyond Saturday close: ${s.start_datetime} - ${s.end_datetime}`);
      }
    }
  });

  await test('check_availability gives a 240-minute major service a 4-hour block', async () => {
    const r = await POST({ action: 'check_availability', service_id: 'SVC003', preferred_date: nextWeekday(6), token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    const s = r.slots[0];
    const mins = (new Date(s.end_datetime) - new Date(s.start_datetime)) / 60000;
    assert(mins === 240, `expected 240 minutes, got ${mins}`);
    assert(s.end_datetime.slice(11, 16) <= '17:00', `runs past close: ${s.end_datetime}`);
  });

  /* --- create_booking --- */
  const bookingDate = nextWeekday(9);

  await test('create_booking writes the booking, customer and calendar event', async () => {
    const r = await POST({
      action: 'create_booking',
      name: 'Jamie Rivers',
      phone: '+61411222333',
      rego: 'JAM123',
      make: 'Mazda',
      model: 'CX-5',
      year: 2019,
      service_id: 'SVC002',
      addon_ids: ['ADD002'],
      start_datetime: `${bookingDate} 09:00`,
      notes: 'test booking',
      token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === true, JSON.stringify(r));
    assert(/^BK\d{5}$/.test(r.booking_id), r.booking_id);
    assert(r.calendar_synced === true, 'calendar not synced');
    assert(r.price_low === 225, `price low ${r.price_low}`);
    assert(/booked in/i.test(r.message), r.message);
    if (!LIVE) {
      const rows = ctx.spreadsheet.getSheetByName('Bookings').data;
      const row = rows.find((x) => x[0] === r.booking_id);
      assert(row, 'booking row missing');
      assert(row[10] === 'Confirmed', `status ${row[10]}`);
      assert(String(row[11]).length > 0, 'calendar_event_id empty');
      const cal = ctx.calendars.get(ctx.calendarId);
      const ev = cal.events.find((e) => e.id === row[11]);
      assert(ev, 'event not in calendar');
      assert(/Minor Service - Jamie Rivers - JAM123/.test(ev.title), ev.title);
      assert(/Booking ID: BK/.test(ev.description) && /Phone: \+61411222333/.test(ev.description), ev.description);
    }
  });

  await test('create_booking enforces bays_available capacity', async () => {
    const payload = {
      action: 'create_booking', service_id: 'SVC002', start_datetime: `${bookingDate} 09:00`,
      token: LIVE ? TOKEN : undefined,
    };
    const second = await POST({ ...payload, name: 'Second Caller', phone: '+61411222444', rego: 'SEC456', make: 'Ford', model: 'Ranger', year: 2020 });
    assert(second.success === true, `second bay should be allowed: ${JSON.stringify(second)}`);
    const third = await POST({ ...payload, name: 'Third Caller', phone: '+61411222555', rego: 'THR789', make: 'Kia', model: 'Rio', year: 2021 });
    assert(third.success === false, `third overlapping booking should fail: ${JSON.stringify(third)}`);
    assert(third.error === 'taken', third.error);
    assert(Array.isArray(third.alternatives) && third.alternatives.length > 0, 'no alternatives offered');
    assert(/just gone|I could do/i.test(third.message), third.message);
    if (!LIVE) {
      for (const phone of ['+61411222444', '+61411222555']) {
        await POST({ action: 'cancel_booking', phone, token: undefined });
      }
    }
  });

  await test('create_booking rejects a past date', async () => {
    const r = await POST({
      action: 'create_booking', name: 'Past Person', phone: '+61411222666', rego: 'PST111',
      service_id: 'SVC001', start_datetime: `${melbourne(-5)} 10:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === false, JSON.stringify(r));
    assert(['lead_time', 'closed', 'outside_hours'].includes(r.error), r.error);
  });

  await test('create_booking rejects a lunch-time slot', async () => {
    const r = await POST({
      action: 'create_booking', name: 'Lunch Person', phone: '+61411222777', rego: 'LUN222',
      service_id: 'SVC002', start_datetime: `${nextWeekday(11)} 12:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === false && r.error === 'lunch', JSON.stringify(r));
    assert(/lunch/i.test(r.message), r.message);
  });

  await test('create_booking rejects a slot outside opening hours', async () => {
    const r = await POST({
      action: 'create_booking', name: 'Early Person', phone: '+61411222888', rego: 'EAR333',
      service_id: 'SVC001', start_datetime: `${nextWeekday(11)} 06:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === false && r.error === 'outside_hours', JSON.stringify(r));
  });

  await test('create_booking rejects a holiday', async () => {
    const r = await POST({
      action: 'create_booking', name: 'Holiday Person', phone: '+61411222999', rego: 'HOL444',
      service_id: 'SVC002', start_datetime: '2026-12-25 09:00', token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === false && r.error === 'closed', JSON.stringify(r));
    assert(/christmas/i.test(r.message), r.message);
  });

  await test('create_booking rejects an invalid phone', async () => {
    const r = await POST({
      action: 'create_booking', name: 'Bad Phone', phone: '12345', rego: 'BAD555',
      service_id: 'SVC001', start_datetime: `${nextWeekday(12)} 10:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === false && r.error === 'invalid_phone', JSON.stringify(r));
  });

  await test('create_booking requires the mandatory fields', async () => {
    const r = await POST({ action: 'create_booking', service_id: 'SVC001', token: LIVE ? TOKEN : undefined });
    assert(r.success === false && r.error === 'missing_fields', JSON.stringify(r));
    assert(r.missing.includes('name') && r.missing.includes('phone'), JSON.stringify(r.missing));
  });

  /* --- reschedule / cancel --- */
  await test('reschedule_booking moves the booking and its event', async () => {
    const created = await POST({
      action: 'create_booking', name: 'Rita Schedule', phone: '+61411333444', rego: 'RES777',
      make: 'Kia', model: 'Sportage', year: 2022, service_id: 'SVC002',
      start_datetime: `${nextWeekday(15)} 10:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(created.success === true, JSON.stringify(created));
    const newDate = nextWeekday(20);
    const r = await POST({ action: 'reschedule_booking', booking_id: created.booking_id, new_start_datetime: `${newDate} 14:00`, token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    assert(r.start_datetime.startsWith(newDate), r.start_datetime);
    if (!LIVE) {
      const cal = ctx.calendars.get(ctx.calendarId);
      const ev = cal.events.find((e) => e.title.includes('RES777'));
      assert(ev, 'event missing after reschedule');
      assert(ev.start.getTime() === new Date(r.start_datetime).getTime(), 'calendar event not moved');
      const row = ctx.spreadsheet.getSheetByName('Bookings').data.find((x) => x[0] === created.booking_id);
      assert(String(row[6]).startsWith(newDate), `sheet not updated: ${row[6]}`);
    }
    await POST({ action: 'cancel_booking', booking_id: created.booking_id, token: LIVE ? TOKEN : undefined });
  });

  await test('reschedule_booking finds a booking by phone', async () => {
    const created = await POST({
      action: 'create_booking', name: 'Phone Lookup', phone: '+61411444555', rego: 'PHN888',
      service_id: 'SVC001', start_datetime: `${nextWeekday(16)} 11:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(created.success === true, JSON.stringify(created));
    const r = await POST({ action: 'reschedule_booking', phone: '+61411444555', new_start_datetime: `${nextWeekday(18)} 15:30`, token: LIVE ? TOKEN : undefined });
    assert(r.success === true, JSON.stringify(r));
    await POST({ action: 'cancel_booking', phone: '+61411444555', token: LIVE ? TOKEN : undefined });
  });

  await test('cancel_booking cancels the row and deletes the event', async () => {
    const created = await POST({
      action: 'create_booking', name: 'Cathy Cancel', phone: '+61411555666', rego: 'CAN999',
      service_id: 'SVC001', start_datetime: `${nextWeekday(17)} 13:00`, token: LIVE ? TOKEN : undefined,
    });
    assert(created.success === true, JSON.stringify(created));
    const r = await POST({ action: 'cancel_booking', booking_id: created.booking_id, token: LIVE ? TOKEN : undefined });
    assert(r.success === true && r.status === 'Cancelled', JSON.stringify(r));
    if (!LIVE) {
      const row = ctx.spreadsheet.getSheetByName('Bookings').data.find((x) => x[0] === created.booking_id);
      assert(row[10] === 'Cancelled', `status ${row[10]}`);
      const cal = ctx.calendars.get(ctx.calendarId);
      assert(!cal.events.some((e) => e.title.includes('CAN999')), 'event not deleted');
    }
  });

  await test('cancelling twice reports it is not active', async () => {
    const created = await POST({
      action: 'create_booking', name: 'Double Cancel', phone: '+61411666777', rego: 'DBL000',
      service_id: 'SVC001', start_datetime: `${nextWeekday(19)} 09:30`, token: LIVE ? TOKEN : undefined,
    });
    await POST({ action: 'cancel_booking', booking_id: created.booking_id, token: LIVE ? TOKEN : undefined });
    const r = await POST({ action: 'cancel_booking', booking_id: created.booking_id, token: LIVE ? TOKEN : undefined });
    assert(r.success === false, JSON.stringify(r));
    assert(['not_found', 'not_active'].includes(r.error), r.error);
  });

  await test('cancel_booking with an unknown reference fails cleanly', async () => {
    const r = await POST({ action: 'cancel_booking', booking_id: 'BK99999', token: LIVE ? TOKEN : undefined });
    assert(r.success === false && r.error === 'not_found', JSON.stringify(r));
    assert(r.message, 'no speakable message');
  });

  /* --- log_call_summary --- */
  await test('log_call_summary appends a Call_Log row', async () => {
    const before = LIVE ? null : ctx.spreadsheet.getSheetByName('Call_Log').data.length;
    const r = await POST({
      action: 'log_call_summary', call_id: 'call_test_001', caller_number: '+61411222333',
      summary: 'Caller booked a minor service.', outcome: 'booked', token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === true, JSON.stringify(r));
    if (!LIVE) {
      const rows = ctx.spreadsheet.getSheetByName('Call_Log').data;
      assert(rows.length > before, 'no Call_Log row added');
      const logged = rows.slice(before).find((r) => /minor service/i.test(`${r[4]} ${r[5]}`));
      assert(logged, 'summary text not present in Call_Log');
      assert(logged[3] === 'log_call_summary', logged[3]);
    }
  });

  /* --- logging behaviour --- */
  await test('every action is written to Call_Log', async () => {
    if (LIVE) return;
    const rows = ctx.spreadsheet.getSheetByName('Call_Log').data;
    const tools = new Set(rows.map((r) => r[3]));
    ['ping', 'get_workshop_info', 'list_services', 'get_price_quote', 'lookup_customer',
      'check_availability', 'create_booking', 'reschedule_booking', 'cancel_booking', 'log_call_summary']
      .forEach((t) => assert(tools.has(t), `no Call_Log entry for ${t}`));
  });

  await test('unauthorised attempts are logged as unauthorised', async () => {
    if (LIVE) return;
    const rows = ctx.spreadsheet.getSheetByName('Call_Log').data;
    assert(rows.some((r) => r[6] === 'unauthorised'), 'no unauthorised log row');
  });

  /* --- Vapi envelope adapter --- */
  await test('Vapi tool-call envelope maps onto the same actions', async () => {
    const r = await POST({
      message: {
        type: 'tool-calls',
        toolCallList: [
          { id: 'tc_price', function: { name: 'get_price_quote', arguments: '{"service_id":"SVC002","addon_ids":["ADD004"]}' } },
          { id: 'tc_info', function: { name: 'get_workshop_info', arguments: '{}' } },
        ],
      },
      token: LIVE ? TOKEN : undefined,
    });
    assert(Array.isArray(r.results) && r.results.length === 2, JSON.stringify(r).slice(0, 200));
    const price = JSON.parse(r.results.find((x) => x.toolCallId === 'tc_price').result);
    assert(price.success === true && price.price_low === 460, JSON.stringify(price).slice(0, 200));
    const info = JSON.parse(r.results.find((x) => x.toolCallId === 'tc_info').result);
    assert(info.success === true && info.workshop.workshop_name, JSON.stringify(info).slice(0, 150));
  });

  await test('Vapi tool call without a token is refused', async () => {
    if (LIVE) {
      const res = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { type: 'tool-calls', toolCallList: [{ id: 'tc_x', function: { name: 'ping', arguments: '{}' } }] } }),
        redirect: 'follow',
      });
      const r = JSON.parse(await res.text());
      assert(/not authorised/i.test(r.results[0].result), JSON.stringify(r).slice(0, 200));
      return;
    }
    const r = call(ctx, { message: { type: 'tool-calls', toolCallList: [{ id: 'tc_x', function: { name: 'ping', arguments: '{}' } }] } }, { token: null });
    assert(/not authorised/i.test(r.results[0].result), JSON.stringify(r).slice(0, 200));
  });

  await test('Vapi end-of-call-report is written to Call_Log', async () => {
    const before = LIVE ? null : ctx.spreadsheet.getSheetByName('Call_Log').data.length;
    const r = await POST({
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        call: { id: 'vapi_call_123', customer: { number: '+61411222333' } },
        analysis: { summary: 'Caller asked about a minor service and booked Tuesday.' },
        artifact: { transcript: 'Agent: thanks for calling...' },
      },
      token: LIVE ? TOKEN : undefined,
    });
    assert(r.success === true, JSON.stringify(r).slice(0, 200));
    if (!LIVE) {
      const rows = ctx.spreadsheet.getSheetByName('Call_Log').data;
      assert(rows.length > before, 'no Call_Log row for the end-of-call report');
      const row = rows.slice(before).find((x) => x[3] === 'end_of_call_report');
      assert(row, 'end_of_call_report not logged');
      assert(/minor service/i.test(`${row[4]} ${row[5]}`), 'summary text missing');
    }
  });

  await test('Vapi status-update is acknowledged and ignored', async () => {
    const r = await POST({ message: { type: 'status-update', status: 'in-progress' }, token: LIVE ? TOKEN : undefined });
    assert(r.success === true && r.ignored === 'status-update', JSON.stringify(r).slice(0, 160));
  });

  /* --- summary --- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) {
    console.log('\nFailures:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  }
  process.exit(failed ? 1 : 0);
})();
