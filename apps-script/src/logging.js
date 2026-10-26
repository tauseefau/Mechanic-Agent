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

function logCall_(tool, caller, request, response, outcome) {
  try {
    appendObject_('Call_Log', {
      timestamp: iso_(new Date()),
      call_id: (request && (request.call_id || request.callId)) || '',
      caller_number: normalisePhone_(caller || (request && request.phone) || '') || String(caller || ''),
      tool_called: String(tool || ''),
      request_json: truncate_(request, LOG_LIMIT),
      response_json: truncate_(response, LOG_LIMIT),
      outcome: String(outcome || '')
    });
  } catch (err) {
    // last resort: do nothing, but never throw into the caller's path
  }
}

function logCallSummary_(params) {
  var summary = String(params.summary || '').trim();
  if (!summary) {
    return { success: false, error: 'missing_summary', message: 'Nothing to log.' };
  }
  logCall_('log_call_summary', params.caller_number || params.phone || '', {
    call_id: params.call_id || '',
    summary: summary,
    outcome: params.outcome || ''
  }, { logged: true }, params.outcome || 'summary');
  return { success: true, message: 'Logged.' };
}
