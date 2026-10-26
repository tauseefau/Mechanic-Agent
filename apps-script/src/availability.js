/**
 * availability.js — implements docs/architecture.md "Availability algorithm".
 * Pure reads: nothing here writes to the sheet or the calendar.
 */

/** service + add-ons -> total duration, resolved add-ons, unknown ids. */
function computeDuration_(service, addonIds) {
  var addons = [];
  var unknown = [];
  (addonIds || []).forEach(function (raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return;
    var a = addonById_(raw);
    if (a) { addons.push(a); } else { unknown.push(String(raw).trim()); }
  });
  var duration = Number(service.duration_minutes || 0);
  addons.forEach(function (a) { duration += Number(a.extra_duration_minutes || 0); });
  return { addons: addons, unknown: unknown, duration_minutes: duration };
}

/**
 * Usable window for a calendar date.
 * {closed:boolean, reason:string, open:minutes, close:minutes, lunch_start, lunch_end}
 */
function dayWindow_(dateStr) {
  var hours = workingHours_();
  var dayStart = localDate_(dateStr, '00:00');
  var weekday = weekdayName_(dayStart);
  var h = hours[weekday];
  var hol = holidayFor_(dateStr);

  if (hol && hol.full_day) return { closed: true, reason: hol.reason, weekday: weekday };
  if (!h) return { closed: true, reason: 'closed', weekday: weekday };
  if (h.is_closed) return { closed: true, reason: 'closed', weekday: weekday };

  var open = parseClock_(h.open);
  var close = parseClock_(h.close);
  if (open === null || close === null || close <= open) {
    return { closed: true, reason: 'closed', weekday: weekday };
  }

  if (hol && !hol.full_day) {
    var holOpen = parseClock_(hol.open);
    var holClose = parseClock_(hol.close);
    if (holOpen !== null && holClose !== null) {
      open = Math.max(open, holOpen);
      close = Math.min(close, holClose);
      if (close <= open) return { closed: true, reason: hol.reason, weekday: weekday };
    }
  }

  return {
    closed: false,
    reason: '',
    weekday: weekday,
    open: open,
    close: close,
    lunch_start: parseClock_(h.lunch_start),
    lunch_end: parseClock_(h.lunch_end),
    holiday: hol || null
  };
}

/** Current occupancy for a date: confirmed sheet bookings + live calendar events. */
function occupancyFor_(dateStr, excludeBookingId) {
  var cfg = getConfig_();
  var dayStart = localDate_(dateStr, '00:00');
  var dayEnd = addMinutes_(dayStart, 24 * 60);
  var out = [];
  var ours = {};

  readTab_('Bookings').forEach(function (b) {
    var status = String(b.status || '').trim().toLowerCase();
    if (status !== 'confirmed') return;
    var id = String(b.booking_id || '').trim();
    if (excludeBookingId && id.toUpperCase() === String(excludeBookingId).toUpperCase()) return;
    var start = parseWhen_(b.start_datetime);
    var end = parseWhen_(b.end_datetime);
    if (!start || !end) return;
    if (end.getTime() <= dayStart.getTime() || start.getTime() >= dayEnd.getTime()) return;
    out.push({ id: id, start: start.getTime(), end: end.getTime(), source: 'sheet' });
    if (b.calendar_event_id) ours[String(b.calendar_event_id)] = true;
  });

  try {
    var cal = CalendarApp.getCalendarById(cfg.calendar_id);
    if (cal) {
      var events = cal.getEvents(addMinutes_(dayStart, -24 * 60), addMinutes_(dayEnd, 24 * 60));
      events.forEach(function (ev) {
        var evId = ev.getId ? String(ev.getId()) : '';
        // our own bookings already counted from the sheet
        var isOurs = false;
        Object.keys(ours).forEach(function (k) {
          if (evId && (evId === k || evId.indexOf(k) > -1 || k.indexOf(evId) > -1)) isOurs = true;
        });
        if (isOurs) return;
        if (ev.isAllDay && ev.isAllDay()) return;   // all-day events are closures, not jobs
        var s = ev.getStartTime(), e = ev.getEndTime();
        if (e.getTime() <= dayStart.getTime() || s.getTime() >= dayEnd.getTime()) return;
        out.push({ id: evId, start: s.getTime(), end: e.getTime(), source: 'calendar' });
      });
    }
  } catch (err) {
    // a calendar outage must not stop a booking; the sheet still counts
    logCall_('occupancyFor_', '', { date: dateStr }, { error: String(err) }, 'error');
  }
  return out;
}

/** Is [start,end) inside a free bay, honouring the buffer rule? */
function slotIsFree_(start, end, occupancy) {
  var cfg = getConfig_();
  var buffer = Number(cfg.buffer_minutes_between_jobs || 0) * 60000;
  var bays = Math.max(1, Number(cfg.bays_available || 1));
  var overlapping = 0;
  for (var i = 0; i < occupancy.length; i++) {
    var o = occupancy[i];
    if (start.getTime() < o.end + buffer && o.start < end.getTime()) overlapping++;
  }
  return overlapping < bays;
}

function overlapsLunch_(start, end, win) {
  if (win.lunch_start === null || win.lunch_end === null) return false;
  var dayStart = new Date(start.getTime());
  dayStart.setUTCHours(0, 0, 0, 0);
  // compare in minutes-of-day of the workshop clock instead of raw ms
  var s = minutesOfDay_(start);
  var e = minutesOfDay_(end);
  if (e === 0) e = 24 * 60;
  return s < win.lunch_end && win.lunch_start < e;
}

/** Candidate start times for a date. */
function candidateStarts_(dateStr, durationMinutes, win, granularity) {
  var out = [];
  if (win.closed) return out;
  if (durationMinutes >= win.close - win.open) {
    out.push(localDate_(dateStr, clock_(win.open)));
    return out;
  }
  for (var m = win.open; m + durationMinutes <= win.close; m += granularity) {
    out.push(localDate_(dateStr, clock_(m)));
  }
  return out;
}

function clock_(minutes) {
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function addDays_(dateStr, days) {
  var d = localDate_(dateStr, '12:00');
  return ymd_(addMinutes_(d, days * 24 * 60));
}

function timePreferenceMatch_(start, pref) {
  if (!pref) return true;
  var p = String(pref).toLowerCase().trim();
  var mins = minutesOfDay_(start);
  if (p === 'morning' || p === 'am') return mins < 12 * 60;
  if (p === 'afternoon' || p === 'pm') return mins >= 12 * 60;
  if (p === 'any' || p === '') return true;
  var clock = parseClock_(p);
  if (clock !== null) return Math.abs(mins - clock) <= 90;   // "around 10" = +-90 min
  return true;
}

function spokenTime_(date) {
  var h = Number(Utilities.formatDate(date, tz_(), 'HH'));
  var m = Number(Utilities.formatDate(date, tz_(), 'mm'));
  var suffix = h < 12 ? 'am' : 'pm';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + (m === 0 ? '' : ':' + (m < 10 ? '0' + m : m)) + ' ' + suffix;
}

function spokenDate_(date) {
  return Utilities.formatDate(date, tz_(), 'EEEE d MMMM');
}

function slotLabel_(date) {
  return spokenDate_(date) + ' at ' + spokenTime_(date);
}

function slotOut_(start, durationMinutes) {
  var end = addMinutes_(start, durationMinutes);
  return {
    start_datetime: iso_(start),
    end_datetime: iso_(end),
    label: slotLabel_(start),
    spoken_time: spokenTime_(start),
    spoken_date: spokenDate_(start)
  };
}

/**
 * check_availability action body. Returns up to 3 slots plus a speech-friendly line.
 */
function checkAvailability_(params) {
  var cfg = getConfig_();
  var service = serviceById_(params.service_id);
  if (!service) {
    return { success: false, error: 'unknown_service', message: 'I could not find that service, sorry.' };
  }

  var resolved = computeDuration_(service, params.addon_ids);
  var duration = service.requires_full_day ? 0 : resolved.duration_minutes;
  var granularity = Number(cfg.slot_granularity_minutes || 30);
  var leadMs = Number(cfg.booking_lead_time_hours || 0) * 3600000;
  var maxDays = Number(cfg.max_days_ahead || 60);
  var now = new Date();
  var earliest = new Date(now.getTime() + leadMs);

  var startDate = params.preferred_date
    ? String(params.preferred_date).substring(0, 10)
    : ymd_(earliest);

  var slots = [];
  var scanned = 0;
  var closedReason = '';

  for (var offset = 0; offset <= maxDays && slots.length < 3; offset++) {
    var dateStr = addDays_(startDate, offset);
    var midnight = localDate_(dateStr, '00:00');
    if (midnight.getTime() > new Date(now.getTime() + maxDays * 86400000).getTime()) break;
    scanned++;

    var win = dayWindow_(dateStr);
    if (win.closed) {
      if (offset === 0 && win.reason && win.reason !== 'closed') closedReason = win.reason;
      continue;
    }

    var dayDuration = service.requires_full_day ? (win.close - win.open) : duration;
    var occupancy = occupancyFor_(dateStr);
    var starts = candidateStarts_(dateStr, dayDuration, win, granularity);

    for (var i = 0; i < starts.length && slots.length < 3; i++) {
      var start = starts[i];
      var end = addMinutes_(start, dayDuration);
      if (start.getTime() < earliest.getTime()) continue;
      if (!timePreferenceMatch_(start, params.time_preference) && offset === 0) continue;
      if (overlapsLunch_(start, end, win)) continue;
      if (!slotIsFree_(start, end, occupancy)) continue;
      slots.push(slotOut_(start, dayDuration));
    }

    if (offset === 0 && slots.length && params.time_preference && slots.length < 3) {
      // widen to any time later the same day before moving to the next day
      for (var k = 0; k < starts.length && slots.length < 3; k++) {
        var s2 = starts[k];
        if (s2.getTime() < earliest.getTime()) continue;
        var e2 = addMinutes_(s2, dayDuration);
        if (overlapsLunch_(s2, e2, win)) continue;
        if (!slotIsFree_(s2, e2, occupancy)) continue;
        var item = slotOut_(s2, dayDuration);
        if (!slots.some(function (x) { return x.start_datetime === item.start_datetime; })) slots.push(item);
      }
    }
  }

  if (!slots.length) {
    return {
      success: false,
      error: 'no_availability',
      slots: [],
      message: closedReason
        ? 'We are closed then, ' + closedReason + '. I can look at another day if that suits.'
        : 'I could not find an open slot in the next ' + maxDays + ' days for that. Would you like me to take your number and have someone call you?'
    };
  }

  var spoken = slots.map(function (s) { return s.label; });
  var sentence;
  if (spoken.length === 1) sentence = 'I have ' + spoken[0] + '.';
  else if (spoken.length === 2) sentence = 'I have ' + spoken[0] + ', or ' + spoken[1] + '.';
  else sentence = 'I have ' + spoken[0] + ', ' + spoken[1] + ', or ' + spoken[2] + '.';

  return {
    success: true,
    slots: slots,
    duration_minutes: service.requires_full_day ? null : duration,
    requires_full_day: service.requires_full_day,
    addons_applied: resolved.addons.map(function (a) { return a.item_name; }),
    unknown_addons: resolved.unknown,
    message: sentence + ' Which one suits?'
  };
}

/** Quote for a service + add-ons, with GST honoured from Config. */
function priceQuote_(params) {
  var cfg = getConfig_();
  var service = serviceById_(params.service_id);
  if (!service) {
    return { success: false, error: 'unknown_service', message: 'I could not find that service, sorry.' };
  }
  var resolved = computeDuration_(service, params.addon_ids);
  var addonTotal = 0;
  resolved.addons.forEach(function (a) { addonTotal += Number(a.price || 0); });

  var low = Number(service.price_from) + addonTotal;
  var high = Number(service.price_to || service.price_from) + addonTotal;
  var includes = cfg.prices_include_gst === true;
  var gstPercent = Number(cfg.gst_percent || 0);

  var outLow = low, outHigh = high, gstNote = '';
  if (!includes) {
    outLow = Math.round(low * (1 + gstPercent / 100) * 100) / 100;
    outHigh = Math.round(high * (1 + gstPercent / 100) * 100) / 100;
    gstNote = ' including GST';
  }

  var duration = service.requires_full_day
    ? Number(service.duration_minutes || 0)
    : resolved.duration_minutes;

  var durationSpeech;
  if (service.requires_full_day) durationSpeech = 'the car stays with us for the day';
  else if (duration <= 30) durationSpeech = 'about half an hour';
  else if (duration <= 60) durationSpeech = 'about an hour';
  else if (duration <= 95) durationSpeech = 'about an hour and a half';
  else if (duration <= 245) durationSpeech = 'about ' + Math.round(duration / 60) + ' hours';
  else durationSpeech = 'most of the day';

  var addonSpeech = resolved.addons.length
    ? ' That includes ' + resolved.addons.map(function (a) { return a.item_name.toLowerCase(); }).join(' and ') + '.'
    : '';

  return {
    success: true,
    service_id: service.service_id,
    service_name: service.service_name,
    price_low: outLow,
    price_high: outHigh,
    price_includes_gst: includes,
    currency: cfg.currency,
    price_range: priceRange_(outLow, outHigh, cfg),
    duration_minutes: duration,
    requires_full_day: service.requires_full_day,
    addons: resolved.addons.map(function (a) {
      return { item_id: a.item_id, item_name: a.item_name, price: a.price, extra_duration_minutes: a.extra_duration_minutes };
    }),
    unknown_addons: resolved.unknown,
    message: 'For a ' + service.service_name.toLowerCase() + ', it is normally ' +
      priceRange_(outLow, outHigh, cfg) + gstNote + '.' + addonSpeech +
      ' We would need it for ' + durationSpeech + '. That is an estimate, the final price is confirmed after we inspect it.'
  };
}
