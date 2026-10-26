/**
 * logging.js — Call_Log. Every request/response pair lands here so the owner can
 * see exactly what the agent said and did. Logging must never break a call.
 */

var LOG_LIMIT = 5000;

function truncate_(value, limit) {
  var s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > limit ? s.substring(0, limit) + '…[truncated]' : s;
}

/**
 * The shared token arrives in the body (Apps Script cannot see headers) and would
 * otherwise be copied verbatim into every Call_Log row — i.e. written into a spreadsheet
 * the owner, and anyone they share it with, can read. Strip it before logging.
 */
function withoutSecret_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  var copy = {};
  Object.keys(request).forEach(function (k) {
    if (String(k).toLowerCase() === 'token') return;
    copy[k] = request[k];
  });
  return copy;
}

function logCall_(tool, caller, request, response, outcome) {
  try {
    appendObject_('Call_Log', {
      timestamp: iso_(new Date()),
      call_id: (request && (request.call_id || request.callId)) || '',
      caller_number: normalisePhone_(caller || (request && request.phone) || '') || String(caller || ''),
      tool_called: String(tool || ''),
      request_json: truncate_(withoutSecret_(request), LOG_LIMIT),
      response_json: truncate_(response, LOG_LIMIT),
      outcome: String(outcome || '')
    });
  } catch (err) {
    // last resort: do nothing, but never throw into the caller's path
  }
}

/**
 * The router (api.js) writes one Call_Log row per request, including the summary text, so
 * this handler does not log again - a second append was costing ~250 ms of tool latency
 * for no extra information.
 */
function logCallSummary_(params) {
  var summary = String(params.summary || '').trim();
  if (!summary) {
    return { success: false, error: 'missing_summary', message: 'Nothing to log.' };
  }
  return {
    success: true,
    call_id: params.call_id || '',
    logged_at: iso_(new Date()),
    message: 'Logged.'
  };
}
