#!/usr/bin/env node
/**
 * vapi/create-assistant.js — recreate the workshop receptionist in Vapi from this repo.
 *
 * Reads, in this order:
 *   .env / process env        VAPI_API_KEY, APPS_SCRIPT_WEBAPP_URL, APPS_SCRIPT_SHARED_TOKEN
 *   the live Config tab        workshop_name, greeting_name_for_agent, transfer_phone_number
 *   vapi/assistant.json        the assistant template (with {{PLACEHOLDERS}})
 *   vapi/system-prompt.md      the system prompt
 *   vapi/tools/*.json          one function tool per backend action
 *
 * Nothing workshop-specific is hardcoded here: the prompt's workshop name, agent name and
 * transfer number come from the sheet, so a new workshop is a Config change plus one run.
 *
 * Usage
 *   node vapi/create-assistant.js                    # create the assistant, print its id
 *   node vapi/create-assistant.js --create-number    # also get a free Vapi number and attach it
 *   node vapi/create-assistant.js --attach <phoneNumberId>
 *   node vapi/create-assistant.js --update <assistantId>   # patch an existing assistant
 *   node vapi/create-assistant.js --dump             # print the resolved payload, create nothing
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VAPI = 'https://api.vapi.ai';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
};

const ENV_TEXT = (() => {
  try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return ''; }
})();

function env(name, fallback = '') {
  if (process.env[name]) return process.env[name];
  const m = ENV_TEXT.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].replace(/^"|"$/g, '').trim() : fallback;
}

const API_KEY = env('VAPI_API_KEY');
const API_BASE = env('APPS_SCRIPT_WEBAPP_URL');
const API_TOKEN = env('APPS_SCRIPT_SHARED_TOKEN');
if (!API_KEY) { console.error('VAPI_API_KEY is required (Bitwarden Secrets Manager or .env)'); process.exit(2); }
if (!API_BASE || !API_TOKEN) { console.error('APPS_SCRIPT_WEBAPP_URL and APPS_SCRIPT_SHARED_TOKEN are required'); process.exit(2); }

async function api(method, endpoint, body) {
  const res = await fetch(`${VAPI}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${endpoint} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

/** Workshop values come from the live sheet, never from this file. */
async function workshopValues() {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_workshop_info', token: API_TOKEN }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`get_workshop_info failed: ${JSON.stringify(json).slice(0, 300)}`);
  const w = json.workshop;
  return {
    workshop_name: w.workshop_name,
    agent_name: w.agent_name,
    transfer_phone: w.transfer_phone_number || '',
    after_hours_message: w.after_hours_message || '',
    cancellation_policy_text: w.cancellation_policy_text || '',
  };
}

function loadTools() {
  const dir = path.join(__dirname, 'tools');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function substitute(text, vars) {
  return String(text).replace(/{{([A-Z_]+)}}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

/**
 * Substitute placeholders in an OBJECT, not in its JSON text. Running the replacement on
 * JSON.stringify output injects the prompt's real newlines into a JSON string literal and
 * the payload stops parsing ("bad control character") - a bug that only shows up with
 * multi-line values like the system prompt.
 */
function deepSubstitute(value, vars) {
  if (typeof value === 'string') return substitute(value, vars);
  if (Array.isArray(value)) return value.map((v) => deepSubstitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => { out[k] = deepSubstitute(value[k], vars); });
    return out;
  }
  return value;
}

(async () => {
  const workshop = await workshopValues();
  const promptTemplate = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');
  const assistantTemplate = JSON.parse(fs.readFileSync(path.join(__dirname, 'assistant.json'), 'utf8'));
  delete assistantTemplate._comment;

  const vars = {
    WORKSHOP_NAME: workshop.workshop_name,
    AGENT_NAME: workshop.agent_name,
    TRANSFER_PHONE: workshop.transfer_phone,
    AFTER_HOURS_MESSAGE: workshop.after_hours_message,
    CANCELLATION_POLICY_TEXT: workshop.cancellation_policy_text,
    API_BASE,
    API_TOKEN,
    SYSTEM_PROMPT: substitute(promptTemplate, {
      WORKSHOP_NAME: workshop.workshop_name,
      AGENT_NAME: workshop.agent_name,
      TRANSFER_PHONE: workshop.transfer_phone,
    }),
  };

  const tools = loadTools().map((t) => deepSubstitute(t, vars));

  const payload = deepSubstitute(assistantTemplate, vars);
  payload.model.tools = tools;

  console.log(`workshop: ${workshop.workshop_name} (agent ${workshop.agent_name})`);
  console.log(`backend:  ${API_BASE}`);
  console.log(`tools:    ${tools.length} -> ${tools.map((t) => t.function.name).join(', ')}`);

  if (flag('dump')) {
    console.log(JSON.stringify(payload, null, 2).slice(0, 4000));
    return;
  }

  const existing = value('update');
  const assistant = existing
    ? await api('PATCH', `/assistant/${existing}`, payload)
    : await api('POST', '/assistant', payload);
  console.log(`assistant ${existing ? 'updated' : 'created'}: ${assistant.id}`);

  let numberId = value('attach');
  if (flag('create-number')) {
    // A free Vapi number is a US number; the area code is required by the API. Importing an
    // Australian local number is a Twilio/Telnyx SIP step (docs/limitations-and-next-steps.md).
    const number = await api('POST', '/phone-number', {
      provider: 'vapi',
      numberDesiredAreaCode: value('area-code') || '415',
      assistantId: assistant.id,
      name: `${workshop.workshop_name} line`,
    });
    numberId = number.id;
    console.log(`phone number created: ${number.number || '(assigned shortly)'} (id ${number.id})`);
  } else if (numberId) {
    await api('PATCH', `/phone-number/${numberId}`, { assistantId: assistant.id });
    console.log(`attached existing number ${numberId} to ${assistant.id}`);
  }

  console.log(JSON.stringify({ assistantId: assistant.id, phoneNumberId: numberId || null }, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
