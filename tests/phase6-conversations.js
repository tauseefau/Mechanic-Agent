#!/usr/bin/env node
/**
 * tests/phase6-conversations.js — Phase 6 live conversation tests.
 *
 * Vapi is the audio path; this harness is the conversation path. It runs the *deployed*
 * assistant's exact system prompt (vapi/system-prompt.md, placeholders resolved from the
 * live Config tab) and its exact nine tool definitions through an LLM with function
 * calling, and executes every tool call against the *live* HTTPS endpoint
 * (https://diyyourdata.com/workshop-api/). The caller is a second LLM with a fixed
 * persona and a fixed set of facts, so the conversation is unscripted but the data is
 * not invented.
 *
 * What this proves: prompt -> tool selection -> live sheet/calendar writes -> spoken
 * readback -> final state. What it does not prove: Vapi's audio/transcription path or
 * the ElevenLabs voice (see docs/testing.md, Phase 6 limitations).
 *
 * Usage
 *   node tests/phase6-conversations.js                # all three scenarios
 *   node tests/phase6-conversations.js --only 1       # one scenario
 *   node tests/phase6-conversations.js --keep         # leave bookings/events behind
 *   node tests/phase6-conversations.js --model openai/gpt-4o-mini
 *
 * Exit code 0 = every assertion in every scenario passed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('../server/gas-runtime');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_ENV = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return ''; } })();
const HOME_ENV = (() => { try { return fs.readFileSync(path.join(process.env.HOME || '/root', '.hermes', '.env'), 'utf8'); } catch (e) { return ''; } })();

function env(name, fallback = '') {
  if (process.env[name]) return process.env[name];
  for (const text of [PROJECT_ENV, HOME_ENV]) {
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (m) return m[1].replace(/^"|"$/g, '').trim();
  }
  return fallback;
}

const API_URL = env('APPS_SCRIPT_WEBAPP_URL');
const TOKEN = env('APPS_SCRIPT_SHARED_TOKEN');
const OPENROUTER_KEY = env('OPENROUTER_API_KEY');
const SHEET_ID = env('SHEET_ID');
const CALENDAR_ID = env('CALENDAR_ID');
const TZ = 'Australia/Melbourne';

const args = process.argv.slice(2);
const ONLY = (() => { const i = args.indexOf('--only'); return i > -1 ? Number(args[i + 1]) : null; })();
const KEEP = args.includes('--keep');
const MODEL = (() => { const i = args.indexOf('--model'); return i > -1 ? args[i + 1] : 'openai/gpt-4o-mini'; })();

if (!API_URL || !TOKEN) { console.error('APPS_SCRIPT_WEBAPP_URL and APPS_SCRIPT_SHARED_TOKEN are required'); process.exit(2); }
if (!OPENROUTER_KEY) { console.error('OPENROUTER_API_KEY is required (project .env or ~/.hermes/.env)'); process.exit(2); }

/* --------------------------------------------------------------- plumbing --- */

const auth = new GoogleAuth(env('GOOGLE_TOKEN_PATH', path.join(process.env.HOME || '/root', '.hermes', 'google_token.json')));
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

function readTab(tab) {
  const res = auth.request('GET', `${SHEETS}/values/${encodeURIComponent(tab)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  return res.values || [];
}

function calendarEvents(daysBack = 2, daysAhead = 120) {
  const from = new Date(Date.now() - daysBack * 86400000).toISOString();
  const to = new Date(Date.now() + daysAhead * 86400000).toISOString();
  const res = auth.request('GET', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&maxResults=2500&orderBy=startTime`);
  return res.items || [];
}

async function endpoint(action, params = {}, budgetMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const res = await fetch(`${API_URL}?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, token: TOKEN, ...params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  } finally { clearTimeout(timer); }
}

async function openrouter(messages, tools, temperature = 0.4) {
  const body = { model: MODEL, temperature, messages };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://diyyourdata.com',
        'X-Title': 'Riverbend Phase 6 conversation tests',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (json.error) throw new Error(`OpenRouter: ${JSON.stringify(json.error).slice(0, 300)}`);
    return json.choices[0].message;
  }
  throw new Error('OpenRouter: exhausted retries');
}

/* ------------------------------------------------------- prompt and tools --- */

function loadTools() {
  const dir = path.join(ROOT, 'vapi', 'tools');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { type: 'function', function: t.function };
  });
}

/**
 * Vapi renders two Liquid tokens in the prompt that a local harness must render itself:
 *   {{ "now" | date: "%A, %B %d, %Y" }}   -> the current date in the workshop timezone
 *   {{customer.number}}                   -> the caller's number for this call
 * Everything else is a plain {{UPPER_CASE}} placeholder resolved from the live Config tab.
 */
function liquidNow(format, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const monthNumber = String(new Date(now.toLocaleString('en-US', { timeZone: TZ })).getMonth() + 1).padStart(2, '0');
  return format
    .replace(/%A/g, parts.weekday)
    .replace(/%B/g, parts.month)
    .replace(/%Y/g, parts.year)
    .replace(/%m/g, monthNumber)
    .replace(/%d/g, parts.day)
    .replace(/%H/g, parts.hour)
    .replace(/%M/g, parts.minute);
}

function buildSystemPrompt(info, callerNumber) {
  const raw = fs.readFileSync(path.join(ROOT, 'vapi', 'system-prompt.md'), 'utf8');
  const vars = {
    WORKSHOP_NAME: info.workshop_name,
    AGENT_NAME: info.agent_name,
    TRANSFER_PHONE: info.transfer_phone_number || '',
    AFTER_HOURS_MESSAGE: info.after_hours_message || '',
    CANCELLATION_POLICY: info.cancellation_policy_text || '',
    CANCELLATION_POLICY_TEXT: info.cancellation_policy_text || '',
  };
  const unresolved = [];
  let prompt = raw.replace(/\{\{\s*"now"\s*\|\s*date:\s*"([^"]+)"\s*\}\}/g, (m, fmt) => liquidNow(fmt));
  prompt = prompt.replace(/\{\{\s*customer\.number\s*\}\}/g, callerNumber || '');
  prompt = prompt.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (vars[key] !== undefined) return vars[key];
    unresolved.push(key);
    return match;
  });
  return { prompt, unresolved };
}

/* ------------------------------------------------------------ the caller --- */

function callerSystem(caller) {
  return [
    `You are ${caller.name}, phoning a car workshop. Speak like a real customer on the phone.`,
    'Rules:',
    '- One or two short sentences per turn. No markdown, no lists, no stage directions.',
    '- Answer only what was asked. Do not volunteer the facts below until they are needed.',
    '- Never invent prices, times, dates, rego or names. Use only these facts:',
    ...Object.entries(caller.facts).map(([k, v]) => `    ${k}: ${v}`),
    `Your goal: ${caller.goal}`,
    '- If the receptionist has finished and your goal is met (or they have told you what you needed), say a short goodbye and end your message with [[HANGUP]].',
    '- If they ask for something you genuinely do not have, say you are not sure and let them guide you.',
  ].join('\n');
}

/* --------------------------------------------------------------- the call --- */

async function runScenario(s) {
  console.log(`\n=== Scenario ${s.id}: ${s.title} ===`);
  const info = await endpoint('get_workshop_info');
  if (!info.success) throw new Error('get_workshop_info failed');
  const { prompt, unresolved } = buildSystemPrompt(info.workshop, s.phone);
  if (unresolved.length) throw new Error(`unresolved placeholders in prompt: ${unresolved.join(', ')}`);

  const tools = loadTools();
  const assistantMessages = [{ role: 'system', content: prompt }];
  const callerMessages = [{ role: 'system', content: callerSystem(s.caller) }];
  const transcript = [];
  const toolLog = [];
  const logRowsBefore = callLogRows().length;

  let opening = s.opening;
  transcript.push({ speaker: info.workshop.agent_name || 'Receptionist', text: opening });
  assistantMessages.push({ role: 'assistant', content: opening });

  let hangup = false;
  for (let turn = 0; turn < s.maxTurns; turn += 1) {
    // the caller hears the receptionist and answers
    callerMessages.push({ role: 'user', content: opening });
    const callerReply = await openrouter(callerMessages, null, 0.5);
    const callerText = String(callerReply.content || '').trim();
    if (callerText) {
      callerMessages.push({ role: 'assistant', content: callerText });
      const clean = callerText.replace(/\[\[HANGUP\]\]/g, '').trim();
      if (clean) transcript.push({ speaker: s.caller.name, text: clean });
      if (/\[\[HANGUP\]\]/.test(callerText) || /\b(bye|goodbye|that'?s all|thanks,? bye)\b/i.test(clean) && s.caller.hangUpWhenSaid) hangup = true;
    }
    // A caller saying goodbye does not end the call for the agent: it still gets one last
    // turn, which is when it is supposed to log the summary and say its own goodbye.
    assistantMessages.push({ role: 'user', content: callerText.replace(/\[\[HANGUP\]\]/g, '').trim() });

    // the receptionist may call tools, then speaks
    for (let step = 0; step < 6; step += 1) {
      const msg = await openrouter(assistantMessages, tools, 0.4);
      const calls = msg.tool_calls || [];
      if (calls.length) {
        assistantMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const call of calls) {
          let payload = {};
          try { payload = JSON.parse(call.function.arguments || '{}'); } catch (e) { payload = {}; }
          let result;
          const started = Date.now();
          try { result = await endpoint(call.function.name, payload); }
          catch (err) { result = { success: false, error: 'harness_error', message: err.message }; }
          toolLog.push({ tool: call.function.name, args: payload, ms: Date.now() - started, result });
          console.log(`    [tool] ${call.function.name}(${JSON.stringify(payload).slice(0, 110)}) -> ${result.success ? 'ok' : result.error || 'fail'} ${Date.now() - started}ms`);
          assistantMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) });
        }
        continue;
      }
      const say = String(msg.content || '').trim();
      if (say) {
        assistantMessages.push({ role: 'assistant', content: say });
        transcript.push({ speaker: info.workshop.agent_name || 'Receptionist', text: say });
        opening = say;
      }
      break;
    }
    if (hangup) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const outcome = await s.verify({ transcript, toolLog, info });

  const newLogRows = callLogRows().slice(logRowsBefore);
  const loggedTools = newLogRows.map((r) => String(r[3]));
  outcome.assertions.push({
    name: 'every tool call for this call landed in Call_Log',
    ok: newLogRows.length >= toolLog.length && toolLog.every((t) => loggedTools.includes(t.tool)),
    detail: `${newLogRows.length} row(s) for ${toolLog.length} tool call(s): ${[...new Set(loggedTools)].join(', ')}`,
  });
  outcome.assertions.push({
    name: 'agent logged a call summary before hanging up',
    ok: loggedTools.includes('log_call_summary'),
    detail: loggedTools.includes('log_call_summary') ? 'summary row present' : 'no log_call_summary row',
  });
  const leaked = newLogRows.filter((r) => String(r[4] || '').includes(TOKEN));
  outcome.assertions.push({
    name: 'Call_Log rows do not contain the shared token',
    ok: leaked.length === 0,
    detail: leaked.length ? `${leaked.length} row(s) leaked the token` : `${newLogRows.length} row(s) checked`,
  });
  console.log(`\n--- transcript (${transcript.length} lines, ${toolLog.length} tool calls) ---`);
  for (const line of transcript) console.log(`  ${line.speaker}: ${line.text}`);
  for (const a of outcome.assertions) console.log(`  ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}${a.ok ? (a.detail ? `  (${a.detail})` : '') : `\n        ${a.detail}`}`);

  return { id: s.id, title: s.title, model: MODEL, transcript, toolLog: toolLog.map((t) => ({ tool: t.tool, args: t.args, ms: t.ms, success: !!t.result.success, message: t.result.message })), assertions: outcome.assertions, evidence: outcome.evidence, unresolved };
}

/* ------------------------------------------------------------ assertions --- */

function nowMelbourne() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts;
}

function futureWeekday(minDays, maxDays = 30) {
  const base = new Date(`${nowMelbourne()}T12:00:00Z`);
  for (let i = minDays; i < maxDays; i += 1) {
    const d = new Date(base.getTime() + i * 86400000);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) return d.toISOString().slice(0, 10);
  }
  throw new Error('no weekday found');
}

async function seedBooking({ name, phone, rego, make, model, year, service = 'SVC002', date }) {
  const avail = await endpoint('check_availability', { service_id: service, preferred_date: date, time_preference: 'morning' });
  if (!avail.success || !avail.slots.length) throw new Error(`no slot on ${date}: ${avail.message}`);
  const slot = avail.slots[0];
  const booking = await endpoint('create_booking', {
    name, phone, rego, make, model, year, service_id: service,
    start_datetime: slot.start_datetime, source: 'phone', notes: 'Phase 6 precondition',
  });
  if (!booking.success) throw new Error(`seed booking failed: ${booking.message}`);
  return { booking_id: booking.booking_id, start_datetime: slot.start_datetime };
}

function bookingsForCustomer(name) {
  const customers = readTab('Customers');
  const row = customers.find((r, i) => i > 0 && String(r[1]).toLowerCase().includes(name.toLowerCase()));
  if (!row) return { customer: null, bookings: [] };
  const id = String(row[0]);
  const bookings = readTab('Bookings').slice(1).filter((r) => String(r[2]) === id);
  return { customer: { id, name: row[1], phone: row[2] }, bookings };
}

function bookingsForPhone(phone) {
  const customers = readTab('Customers');
  const digits = String(phone).replace(/\D/g, '').slice(-9);
  const row = customers.find((r, i) => i > 0 && String(r[2]).replace(/\D/g, '').endsWith(digits));
  if (!row) return { customer: null, bookings: [] };
  const id = String(row[0]);
  const bookings = readTab('Bookings').slice(1).filter((r) => String(r[2]) === id);
  return { customer: { id, name: row[1], phone: row[2] }, bookings };
}

function eventsMentioning(text) {
  const needle = String(text).toLowerCase();
  return calendarEvents().filter((ev) => `${ev.summary || ''} ${ev.description || ''}`.toLowerCase().includes(needle));
}

function callLogRows() {
  const rows = readTab('Call_Log');
  return rows.slice(1).filter((r) => r[0]);
}

/* ------------------------------------------------------------ scenarios --- */

const NEW_PHONE = '+61' + '478901' + '234';
const RETURN_PHONE = '+61' + '439876' + '543';
const CANCEL_PHONE = '+61' + '412345' + '987';

const scenarios = [
  {
    id: 1,
    title: 'New customer books a minor service',
    phone: NEW_PHONE,
    maxTurns: 18,
    opening: 'Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?',
    caller: {
      name: 'Nadia',
      goal: 'Book a minor service for your Corolla, get the price, and get a time that suits.',
      facts: {
        'your name': 'Nadia Okafor',
        'your mobile': NEW_PHONE,
        'your car': 'a 2016 Toyota Corolla, rego RVB442',
        'what you want': 'a minor service, not a major one',
        'when suits you': 'a morning next week, any weekday',
        'add-ons': 'no thanks, nothing extra',
        'anything else': 'no, that is all',
      },
    },
    async verify({ toolLog }) {
      const assertions = [];
      const { customer, bookings } = bookingsForPhone(NEW_PHONE);
      const live = bookings.filter((b) => String(b[10]) === 'Confirmed');
      assertions.push({
        name: 'one confirmed booking written for the new caller',
        ok: !!customer && live.length === 1,
        detail: customer ? `${live.length} confirmed row(s), booking ${live[0] ? live[0][0] : '-'}` : 'customer not created',
      });
      const booking = live[0];
      if (booking) {
        const summary = eventsMentioning(String(booking[0]));
        const regoHit = eventsMentioning('RVB442');
        assertions.push({
          name: 'calendar event created for that booking',
          ok: regoHit.length === 1,
          detail: `${regoHit.length} event(s) mentioning RVB442${regoHit[0] ? ` at ${regoHit[0].start.dateTime}` : ''}`,
        });
        assertions.push({
          name: 'booking linked to its calendar event id',
          ok: String(booking[11] || '').length > 10,
          detail: `calendar_event_id ${String(booking[11] || '').slice(0, 12)}…`,
        });
        assertions.push({
          name: 'booking is inside opening hours, not on a closure',
          ok: /T(0[89]|1[0-6]):/.test(String(booking[6])),
          detail: `starts ${booking[6]}`,
        });
      }
      const tools = new Set(toolLog.map((t) => t.tool));
      assertions.push({
        name: 'agent used lookup, quote, availability and create',
        ok: ['lookup_customer', 'get_price_quote', 'check_availability', 'create_booking'].every((t) => tools.has(t)),
        detail: [...tools].join(', '),
      });
      return { assertions, evidence: { customer, booking } };
    },
  },
  {
    id: 2,
    title: 'Returning customer reschedules',
    phone: RETURN_PHONE,
    maxTurns: 16,
    opening: 'Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?',
    seed: async () => seedBooking({ name: 'Sam Whitfield', phone: RETURN_PHONE, rego: 'SWX889', make: 'Mazda', model: 'BT-50', year: 2020, date: futureWeekday(4) }),
    caller: {
      name: 'Sam',
      goal: 'Move your existing booking to a different day because something came up.',
      facts: {
        'your name': 'Sam',
        'your car': 'the Mazda BT-50',
        'what you want': 'to move the booking to another morning, later in the week or early next week',
      },
      hangUpWhenSaid: true,
    },
    async verify({ seed, toolLog }) {
      const assertions = [];
      const { bookings } = bookingsForPhone(RETURN_PHONE);
      const live = bookings.filter((b) => String(b[10]) === 'Confirmed');
      assertions.push({
        name: 'still exactly one booking (no duplicate row)',
        ok: live.length === 1 && live[0] && String(live[0][0]) === String(seed.booking_id),
        detail: `${live.length} confirmed row(s); seed was ${seed.booking_id}`,
      });
      const booking = live[0];
      if (booking) {
        assertions.push({
          name: 'booking moved to a different start time',
          ok: String(booking[6]) !== String(seed.start_datetime),
          detail: `${seed.start_datetime} -> ${booking[6]}`,
        });
        const ev = calendarEvents().filter((e) => String(e.id) === String(booking[11]));
        assertions.push({
          name: 'calendar event moved, same event id',
          ok: ev.length === 1 && String(ev[0].start.dateTime || '').slice(0, 16) === String(booking[6]).slice(0, 16),
          detail: ev.length ? `${ev[0].id.slice(0, 12)}… at ${ev[0].start.dateTime}` : 'event not found by id',
        });
        assertions.push({ name: 'old slot no longer occupied by this booking', ok: ev.length === 1 && String(ev[0].start.dateTime).slice(0, 16) !== String(seed.start_datetime).slice(0, 16), detail: 'old event replaced, not duplicated' });
      }
      const tools = new Set(toolLog.map((t) => t.tool));
      assertions.push({
        name: 'agent looked the caller up and used reschedule_booking',
        ok: tools.has('lookup_customer') && tools.has('reschedule_booking'),
        detail: [...tools].join(', '),
      });
      return { assertions, evidence: { seed, booking } };
    },
  },
  {
    id: 3,
    title: 'Price enquiry then cancels',
    phone: CANCEL_PHONE,
    maxTurns: 16,
    opening: 'Thanks for calling Riverbend Auto Service, this is Charlie. How can I help today?',
    seed: async () => seedBooking({ name: 'Priya Raman', phone: CANCEL_PHONE, rego: 'PRX221', make: 'Hyundai', model: 'i30', year: 2019, date: futureWeekday(5) }),
    caller: {
      name: 'Priya',
      goal: 'Ask how much a major service costs, then cancel your existing booking.',
      facts: {
        'your name': 'Priya',
        'your car': 'the Hyundai i30',
        'what you want first': 'the price of a major service — insist on a price range before anything else happens',
        'then': 'once Charlie has told you the major service price, say you need to cancel the booking you already have',
      },
      hangUpWhenSaid: true,
    },
    async verify({ seed, toolLog }) {
      const assertions = [];
      const { bookings } = bookingsForPhone(CANCEL_PHONE);
      const cancelled = bookings.filter((b) => String(b[10]) === 'Cancelled');
      assertions.push({
        name: 'booking marked Cancelled, not deleted',
        ok: cancelled.length === 1 && String(cancelled[0][0]) === String(seed.booking_id),
        detail: `${cancelled.length} cancelled row(s); seed was ${seed.booking_id}`,
      });
      const events = eventsMentioning('PRX221');
      assertions.push({ name: 'calendar event removed', ok: events.length === 0, detail: `${events.length} event(s) left mentioning PRX221` });
      const tools = new Set(toolLog.map((t) => t.tool));
      assertions.push({
        name: 'agent quoted from the sheet then cancelled',
        ok: tools.has('get_price_quote') && tools.has('cancel_booking'),
        detail: [...tools].join(', '),
      });
      const quote = toolLog.find((t) => t.tool === 'get_price_quote' && t.result && t.result.success && /Major Service/i.test(String(t.result.service_name || '')));
      assertions.push({
        name: 'major service quote came from the sheet',
        ok: !!quote && quote.result.price_low === 480 && quote.result.price_high === 750,
        detail: quote ? `${quote.result.price_range}` : 'no major-service quote in the tool log',
      });
      return { assertions, evidence: { seed, cancelled } };
    },
  },
];

/* ------------------------------------------------------------------ main --- */

(async () => {
  fs.mkdirSync(path.join(ROOT, 'tests', 'phase6-runs'), { recursive: true });
  const chosen = ONLY ? scenarios.filter((s) => s.id === ONLY) : scenarios;
  const runs = [];
  let failures = 0;

  for (const s of chosen) {
    const run = { id: s.id, title: s.title, started_at: new Date().toISOString() };
    try {
      if (s.seed) run.seed = await s.seed();
      const result = await runScenario({ ...s, verify: (ctx) => s.verify({ ...ctx, seed: run.seed }) });
      Object.assign(run, result);
      failures += result.assertions.filter((a) => !a.ok).length;
    } catch (err) {
      console.error(`Scenario ${s.id} crashed: ${err.stack || err.message}`);
      run.assertions = [{ name: 'scenario completed', ok: false, detail: err.message }];
      failures += 1;
    }
    runs.push(run);
    fs.writeFileSync(path.join(ROOT, 'tests', 'phase6-runs', `scenario-${run.id}.json`), JSON.stringify(run, null, 2));
  }

  const total = runs.reduce((n, r) => n + r.assertions.length, 0);
  const passed = runs.reduce((n, r) => n + r.assertions.filter((a) => a.ok).length, 0);
  console.log(`\n${passed}/${total} assertions passed across ${runs.length} scenario(s), model ${MODEL}`);
  if (failures) process.exitCode = 1;
})();
