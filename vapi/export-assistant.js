#!/usr/bin/env node
/**
 * vapi/export-assistant.js — record what Vapi is actually running, without the secrets.
 *
 * Fetches the live assistant, keeps only the fields that describe its behaviour (ids,
 * org, timestamps and version counters are dropped because they differ per account),
 * rewrites the server URL and token back to placeholders, refuses to write if any secret
 * survives, then writes vapi/assistant.export.json.
 *
 * Phase 5 exported by hand. A hand export drifts silently after the next prompt edit, so
 * this is a script and Phase 6's run is the proof it reproduces.
 *
 * Usage
 *   node vapi/export-assistant.js                     # uses VAPI_ASSISTANT_ID from .env
 *   node vapi/export-assistant.js --id <assistantId>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_TEXT = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch (e) { return ''; } })();
function env(name, fallback = '') {
  if (process.env[name]) return process.env[name];
  const m = ENV_TEXT.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].replace(/^"|"$/g, '').trim() : fallback;
}

const args = process.argv.slice(2);
const idx = args.indexOf('--id');
const ASSISTANT_ID = idx > -1 ? args[idx + 1] : env('VAPI_ASSISTANT_ID');
const API_KEY = env('VAPI_API_KEY');
const API_BASE = env('APPS_SCRIPT_WEBAPP_URL');
const TOKEN = env('APPS_SCRIPT_SHARED_TOKEN');

if (!API_KEY || !ASSISTANT_ID) { console.error('VAPI_API_KEY and an assistant id are required'); process.exit(2); }

const KEEP = ['name', 'voice', 'model', 'firstMessage', 'firstMessageMode', 'endCallFunctionEnabled',
  'transcriber', 'silenceTimeoutSeconds', 'serverMessages', 'serverUrl', 'endCallPhrases',
  'maxDurationSeconds', 'backgroundSound', 'backchannelingEnabled', 'analysisPlan'];

(async () => {
  const res = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /assistant/${ASSISTANT_ID} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  const live = JSON.parse(text);

  const out = {};
  KEEP.forEach((k) => { if (live[k] !== undefined) out[k] = live[k]; });

  const scrub = (value) => {
    if (typeof value === 'string') {
      return value
        .split(`${API_BASE}?token=${TOKEN}`).join('{{API_BASE}}?token={{API_TOKEN}}')
        .split(API_BASE).join('{{API_BASE}}')
        .split(TOKEN).join('{{API_TOKEN}}');
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const o = {};
      Object.keys(value).forEach((k) => { o[k] = scrub(value[k]); });
      return o;
    }
    return value;
  };

  const clean = scrub(out);
  const asText = JSON.stringify(clean, null, 2);

  // a token that survives the scrub must stop the export, not be committed
  const leaks = [TOKEN, API_KEY].filter((s) => s && asText.includes(s));
  if (leaks.length) {
    console.error(`refusing to write: ${leaks.length} secret(s) survived sanitisation`);
    process.exit(1);
  }

  const prompt = String((clean.model.messages || []).find((m) => m.role === 'system')?.content || '');
  const toolCount = ((clean.model.tools || []).length);
  const unresolved = (prompt.match(/\{\{[A-Z_]+\}\}/g) || []);

  fs.writeFileSync(path.join(__dirname, 'assistant.export.json'), `${asText}\n`);
  console.log(`wrote vapi/assistant.export.json`);
  console.log(`  model        ${clean.model.provider}/${clean.model.model} temp ${clean.model.temperature}`);
  console.log(`  prompt       ${prompt.length} chars, ${unresolved.length} unresolved placeholder(s)${unresolved.length ? `: ${unresolved.join(', ')}` : ''}`);
  console.log(`  tools        ${toolCount}`);
  console.log(`  voice        ${clean.voice.provider} ${clean.voice.voiceId} (${clean.voice.model})`);
  console.log(`  transcriber  ${clean.transcriber.provider} ${clean.transcriber.model} ${clean.transcriber.language}`);
  console.log(`  first msg    ${clean.firstMessage}`);
  if (unresolved.length) process.exitCode = 1;
})().catch((err) => { console.error(err.message); process.exit(1); });
