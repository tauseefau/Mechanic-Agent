/**
 * api.js — the single web app entry point.
 *
 * POST (preferred) or GET with a JSON body / form field. Every action returns
 * {success, message, ...}. The shared token comes from the SHARED_TOKEN script
 * property; Apps Script does not expose request headers, so the token is accepted
 * from the JSON body, a form field, or the query string (?token=...).
 */

var ACTIONS = {
  ping: function () { return { success: true, pong: true, message: 'ok' }; },
  get_workshop_info: function () {
    var info = workshopInfo_();
    var cfg = getConfig_();
    var hoursSentence = info.hours.map(function (h) {
      if (h.closed) return h.day + ' closed';
      var lunch = (h.lunch_start && h.lunch_end) ? ' with a break ' + h.lunch_start + ' to ' + h.lunch_end : '';
      return h.day + ' ' + h.open + ' to ' + h.close + lunch;
    }).join('; ');
    var closures = info.closures.slice(0, 3).map(function (c) {
      return c.date + ' closed for ' + c.reason;
    }).join('; ');
    return {
      success: true,
      workshop: info,
      message: info.workshop_name + ' is at ' + info.address + '. We are open ' + hoursSentence + '.' +
        (closures ? ' Coming up: ' + closures + '.' : '') +
        (info.after_hours_message ? ' ' : '')
    };
  },
  list_services: function () {
    var data = servicesPublic_();
    var names = data.services.map(function (s) { return s.service_name + ' from ' + s.price_range; });
    return {
      success: true,
      services: data.services,
      addons: data.addons,
      message: 'We do ' + data.services.map(function (s) { return s.service_name.toLowerCase(); }).join(', ') +
        '. Add-ons we can do at the same time are ' + data.addons.map(function (a) { return a.item_name.toLowerCase(); }).join(', ') + '.'
    };
  },
  get_price_quote: function (p) { return priceQuote_(p); },
  lookup_customer: function (p) { return lookupCustomer_(p); },
  check_availability: function (p) { return checkAvailability_(p); },
  create_booking: function (p) { return createBooking_(p); },
  reschedule_booking: function (p) { return rescheduleBooking_(p); },
  cancel_booking: function (p) { return cancelBooking_(p); },
  log_call_summary: function (p) { return logCallSummary_(p); }
};

function parseBody_(e) {
  var body = {};
  if (e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  }
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) {
      if (body[k] === undefined) body[k] = e.parameter[k];
    });
  }
  return body;
}

function tokenFrom_(e, body) {
  if (body && body.token) return String(body.token);
  if (e && e.parameter && e.parameter.token) return String(e.parameter.token);
  if (e && e.headers) {
    var keys = Object.keys(e.headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === 'x-auth-token') return String(e.headers[keys[i]]);
    }
  }
  return '';
}

function authorised_(e, body) {
  var expected = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN');
  if (!expected) return { ok: false, reason: 'no_token_configured' };
  var given = tokenFrom_(e, body);
  if (!given) return { ok: false, reason: 'no_token' };
  // constant-time-ish compare
  if (given.length !== expected.length) return { ok: false, reason: 'bad_token' };
  var diff = 0;
  for (var i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: 'bad_token' };
}

function handle_(e) {
  var body = parseBody_(e);
  var action = String(body.action || (e && e.parameter && e.parameter.action) || '').trim();

  var auth = authorised_(e, body);
  if (!auth.ok) {
    logCall_(action || 'unauthorised', body.phone || '', body, { error: auth.reason }, 'unauthorised');
    return { success: false, error: 'unauthorised', reason: auth.reason, message: 'That request was not authorised.' };
  }

  if (!action || !ACTIONS[action]) {
    return { success: false, error: 'unknown_action', action: action, message: 'I do not know how to do that.' };
  }

  var started = new Date().getTime();
  try {
    var result = ACTIONS[action](body);
    if (result && result.message === undefined) result.message = 'Done.';
    logCall_(action, body.phone || body.caller_number || '', body, result, result && result.success ? 'success' : (result && result.error) || 'error');
    return result;
  } catch (err) {
    var failure = {
      success: false,
      error: 'exception',
      detail: String(err),
      message: 'Sorry, I had trouble with that just now. Could you try that once more?'
    };
    logCall_(action, body.phone || body.caller_number || '', body, failure, 'exception');
    return failure;
  }
}

/**
 * Vapi calls this endpoint in two shapes that are not our {action:...} contract:
 *   1. a tool call batch      {message:{type:'tool-calls', toolCallList:[{id, function:{name, arguments}}]}}
 *   2. lifecycle events       {message:{type:'end-of-call-report'|'status-update', ...}}
 * Both carry the token in the query string (server.url / serverUrl end in ?token=...).
 * The adapter below maps them onto the same ACTIONS table, so there is one code path for
 * a curl test, the Vapi assistant and the end-of-call webhook.
 */
function handleVapi_(body, e) {
  var msg = body.message || {};
  var auth = authorised_(e, body);

  if (msg.type === 'tool-calls') {
    var calls = msg.toolCallList || [];
    var results = calls.map(function (call) {
      var fn = call.function || {};
      var name = String(fn.name || '');
      var args = {};
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {});
      } catch (err) { args = {}; }

      if (!auth.ok) {
        logCall_(name || 'vapi_tool', args.phone || '', args, { error: auth.reason }, 'unauthorised');
        return { toolCallId: call.id, result: 'That request was not authorised.' };
      }

      var handler = ACTIONS[name];
      if (!handler) {
        return { toolCallId: call.id, result: JSON.stringify({ success: false, error: 'unknown_action', message: 'I do not know how to do that.' }) };
      }
      try {
        var res = handler(args);
        if (res && res.message === undefined) res.message = 'Done.';
        logCall_(name, args.phone || args.caller_number || '', args, res, res && res.success ? 'success' : (res && res.error) || 'error');
        return { toolCallId: call.id, result: JSON.stringify(res) };
      } catch (err) {
        var failure = { success: false, error: 'exception', detail: String(err), message: 'Sorry, I had trouble with that just now. Could you try that once more?' };
        logCall_(name, args.phone || '', args, failure, 'exception');
        return { toolCallId: call.id, result: JSON.stringify(failure) };
      }
    });
    return { results: results };
  }

  if (msg.type === 'end-of-call-report') {
    if (!auth.ok) return { success: false, error: 'unauthorised' };
    var call = msg.call || {};
    var analysis = msg.analysis || {};
    var summary = (analysis.summary || msg.summary || '').toString().trim();
    var endedReason = msg.endedReason || call.endedReason || 'ended';
    var callerNumber = (call.customer && call.customer.number) || '';
    var transcript = (msg.artifact && msg.artifact.transcript) || msg.transcript || '';
    logCall_('end_of_call_report', callerNumber, {
      call_id: call.id || '',
      ended_reason: endedReason,
      transcript_chars: String(transcript).length
    }, { summary: summary, outcome: endedReason }, summary ? 'summary' : 'report');
    return { success: true, logged: true };
  }

  if (msg.type === 'status-update') {
    return { success: true, ignored: 'status-update' };
  }

  return { success: true, ignored: String(msg.type || 'unknown') };
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (body && body.message && body.message.type) return jsonOut_(handleVapi_(body, e));
    return jsonOut_(handle_(e));
  } catch (err) {
    return jsonOut_({ success: false, error: 'fatal', message: 'Sorry, something went wrong.' });
  }
}

function doGet(e) {
  var body = parseBody_(e);
  if (!body.action && e && e.parameter && e.parameter.action) body.action = e.parameter.action;
  if (body && body.message && body.message.type) return jsonOut_(handleVapi_(body, e));
  return jsonOut_(handle_(e));
}

/** Health check from the editor: run this to see a summary without curl. */
function selfTest() {
  var out = {};
  ['get_workshop_info', 'list_services'].forEach(function (a) {
    out[a] = ACTIONS[a]({});
  });
  out.config_keys = Object.keys(getConfig_()).length;
  return out;
}
