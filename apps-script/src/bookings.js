/**
 * bookings.js — writes. Every write path runs inside LockService so two callers
 * cannot take the same slot (docs/architecture.md steps 11-12).
 */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(30000);
  if (!got) {
    return { success: false, error: 'busy', message: 'The booking system is busy for a moment. Can you give me one second and ask again?' };
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) { /* already released */ }
  }
}

function snapToGrid_(start, win, granularity) {
  var mins = minutesOfDay_(start);
  var rel = mins - win.open;
  // before opening or after closing: hand the raw time back so validateSlot_ rejects it
  // rather than quietly moving the caller's appointment
  if (rel < 0 || mins > win.close) return start;
  var snapped = win.open + Math.ceil(rel / granularity) * granularity;
  return localDate_(ymd_(start), clock_(snapped));
}

/** Validate one concrete start time for a service. */
function validateSlot_(start, service, durationMinutes, excludeBookingId) {
  var cfg = getConfig_();
  var dateStr = ymd_(start);
  var win = dayWindow_(dateStr);
  if (win.closed) {
    return { ok: false, reason: 'closed', detail: win.reason, date: dateStr };
  }

  var dayDuration = service.requires_full_day ? (win.close - win.open) : durationMinutes;
  var end = addMinutes_(start, dayDuration);

  if (service.requires_full_day && !(minutesOfDay_(start) === win.open)) {
    return { ok: false, reason: 'full_day', detail: 'full day service must start at opening', date: dateStr };
  }
  if (minutesOfDay_(start) < win.open || minutesOfDay_(end) > win.close) {
    return { ok: false, reason: 'outside_hours', detail: 'outside opening hours', date: dateStr };
  }
  if (overlapsLunch_(start, end, win)) {
    return { ok: false, reason: 'lunch', detail: 'that is our lunch break', date: dateStr };
  }

  var leadMs = Number(cfg.booking_lead_time_hours || 0) * 3600000;
  if (start.getTime() < new Date().getTime() + leadMs - 1) {
    return { ok: false, reason: 'lead_time', detail: 'that is too soon', date: dateStr };
  }
  var maxDays = Number(cfg.max_days_ahead || 60);
  if (start.getTime() > new Date().getTime() + maxDays * 86400000) {
    return { ok: false, reason: 'too_far', detail: 'that is further ahead than we book', date: dateStr };
  }

  var occupancy = occupancyFor_(dateStr, excludeBookingId);
  if (!slotIsFree_(start, end, occupancy)) {
    return { ok: false, reason: 'taken', detail: 'that slot is already taken', date: dateStr };
  }

  return { ok: true, start: start, end: end, duration_minutes: dayDuration, win: win };
}

function alternativesFor_(service, addonIds, dateStr, timePreference) {
  var res = checkAvailability_({
    service_id: service.service_id,
    addon_ids: addonIds,
    preferred_date: dateStr,
    time_preference: timePreference
  });
  return res.slots || [];
}

function calendarEventBody_(booking, customer, vehicle, service, addons, quote) {
  var cfg = getConfig_();
  var addonNames = addons.map(function (a) { return a.item_name; }).join(', ') || 'none';
  var vehicleBits = [vehicle.year, vehicle.make, vehicle.model].filter(function (x) { return x !== '' && x !== undefined && x !== null; }).join(' ');
  return {
    title: service.service_name + ' - ' + (customer.full_name || 'Customer') + ' - ' + (vehicle.rego || ''),
    description:
      'Phone: ' + normalisePhone_(customer.phone) + '\n' +
      'Vehicle: ' + vehicleBits + ' (' + (vehicle.rego || '') + ')\n' +
      'Add-ons: ' + addonNames + '\n' +
      'Estimated price: ' + priceRange_(quote.price_low, quote.price_high, cfg) +
      (quote.price_includes_gst ? ' (GST inclusive)' : ' (plus GST)') + '\n' +
      'Booking ID: ' + booking.booking_id + '\n' +
      'Booked by: AI receptionist'
  };
}

function createBooking_(params) {
  var cfg = getConfig_();
  var missing = [];
  if (!params.name) missing.push('name');
  if (!params.phone) missing.push('phone');
  if (!params.rego) missing.push('rego');
  if (!params.service_id) missing.push('service_id');
  if (!params.start_datetime) missing.push('start_datetime');
  if (missing.length) {
    return { success: false, error: 'missing_fields', missing: missing, message: 'I am missing the ' + missing.join(', ') + '. Could you give me that?' };
  }

  var phone = normalisePhone_(params.phone);
  if (!isValidPhone_(phone)) {
    return { success: false, error: 'invalid_phone', message: 'Sorry, that phone number does not look right. Could you say it again slowly?' };
  }

  var service = serviceById_(params.service_id);
  if (!service) {
    return { success: false, error: 'unknown_service', message: 'I could not find that service on our list, sorry.' };
  }

  var resolved = computeDuration_(service, params.addon_ids);
  var rawStart = parseWhen_(params.start_datetime);
  if (!rawStart) {
    return { success: false, error: 'bad_datetime', message: 'Sorry, I did not catch that date and time.' };
  }

  var start = rawStart;
  var win0 = dayWindow_(ymd_(rawStart));
  if (!win0.closed) {
    start = snapToGrid_(rawStart, win0, Number(cfg.slot_granularity_minutes || 30));
  }

  return withLock_(function () {
    var check = validateSlot_(start, service, resolved.duration_minutes, null);
    if (!check.ok) {
      var alts = alternativesFor_(service, params.addon_ids, check.date, null);
      var spoken = alts.map(function (s) { return s.label; });
      var why =
        check.reason === 'closed' ? 'We are closed then' + (check.detail && check.detail !== 'closed' ? ', ' + check.detail : '') + '.' :
        check.reason === 'lunch' ? 'That is our lunch break.' :
        check.reason === 'outside_hours' ? 'That is outside our opening hours.' :
        check.reason === 'lead_time' ? 'That is a bit too soon for us to fit in.' :
        check.reason === 'taken' ? 'That one has just gone.' :
        'We cannot do that time.';
      return {
        success: false,
        error: check.reason,
        alternatives: alts,
        message: why + (spoken.length ? ' I could do ' + spoken.join(', ') + '. Would one of those work?' : ' Would another day suit?')
      };
    }

    var quote = priceQuote_({ service_id: service.service_id, addon_ids: params.addon_ids });
    var custResult = upsertCustomer_({ name: params.name, phone: phone, email: params.email || '' });
    var customer = custResult.customer;
    var vehResult = upsertVehicle_(customer.customer_id, {
      rego: params.rego,
      make: params.make,
      model: params.model,
      year: params.year,
      odometer: params.odometer,
      notes: params.notes
    });
    var vehicle = vehResult.vehicle || { rego: String(params.rego || '').toUpperCase(), make: '', model: '', year: '' };

    var bookingId = nextId_('Bookings', 'booking_id', 'BK');
    var booking = {
      booking_id: bookingId,
      created_at: iso_(new Date()),
      customer_id: customer.customer_id,
      vehicle_id: vehicle.vehicle_id || '',
      service_id: service.service_id,
      addons: resolved.addons.map(function (a) { return a.item_id; }).join(';'),
      start_datetime: iso_(check.start),
      end_datetime: iso_(check.end),
      estimated_price_low: quote.price_low,
      estimated_price_high: quote.price_high,
      status: 'Confirmed',
      calendar_event_id: '',
      source: 'phone',
      notes: (params.notes || '') + (resolved.unknown.length ? ' unknown_addons:' + resolved.unknown.join(',') : '')
    };

    var rowNumber = appendObject_('Bookings', booking);

    var eventId = '';
    var syncNote = '';
    try {
      var cal = CalendarApp.getCalendarById(cfg.calendar_id);
      if (!cal) throw new Error('calendar not found: ' + cfg.calendar_id);
      var body = calendarEventBody_(booking, customer, vehicle, service, resolved.addons, quote);
      var event = cal.createEvent(body.title, check.start, check.end, { description: body.description });
      eventId = event.getId();
      setCell_('Bookings', rowNumber, 'calendar_event_id', eventId);
      booking.calendar_event_id = eventId;
    } catch (err) {
      syncNote = ' calendar_sync_failed';
      setCell_('Bookings', rowNumber, 'notes', (booking.notes + ' calendar_sync_failed: ' + String(err)).substring(0, 480));
      logCall_('create_booking', phone, params, { error: String(err) }, 'calendar_error');
    }

    return {
      success: true,
      booking_id: bookingId,
      customer_id: customer.customer_id,
      customer_created: custResult.created,
      vehicle_id: booking.vehicle_id,
      service_id: service.service_id,
      service_name: service.service_name,
      addons: resolved.addons.map(function (a) { return a.item_name; }),
      start_datetime: booking.start_datetime,
      end_datetime: booking.end_datetime,
      label: slotLabel_(check.start),
      price: priceRange_(quote.price_low, quote.price_high, cfg),
      price_low: quote.price_low,
      price_high: quote.price_high,
      calendar_event_id: eventId,
      calendar_synced: !syncNote,
      message: 'You are booked in for a ' + service.service_name.toLowerCase() + ' on ' + slotLabel_(check.start) +
        ', booking reference ' + bookingId + '. The estimate is ' + priceRange_(quote.price_low, quote.price_high, cfg) +
        ', and the final price is confirmed after we inspect it.'
    };
  });
}

/** Find a booking by id, or by phone + date (yyyy-MM-dd). */
function findBooking_(params) {
  var rows = readTab_('Bookings');
  var id = String(params.booking_id || '').trim().toUpperCase();
  if (id) {
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].booking_id || '').trim().toUpperCase() === id) return rows[i];
    }
    return null;
  }
  var phone = normalisePhone_(params.phone);
  if (!phone) return null;
  var cust = findCustomerByPhone_(phone);
  if (!cust) return null;
  var wantDate = params.date ? String(params.date).substring(0, 10) : '';
  var candidates = rows.filter(function (b) {
    if (String(b.customer_id).trim() !== String(cust.customer_id).trim()) return false;
    if (String(b.status || '').trim().toLowerCase() !== 'confirmed') return false;
    if (!wantDate) return true;
    var s = parseWhen_(b.start_datetime);
    return s && ymd_(s) === wantDate;
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) {
    return parseWhen_(a.start_datetime).getTime() - parseWhen_(b.start_datetime).getTime();
  });
  return candidates[0];
}

function rescheduleBooking_(params) {
  var target = findBooking_(params);
  if (!target) {
    return { success: false, error: 'not_found', message: 'I could not find that booking. Could you give me the booking reference?' };
  }
  if (String(target.status || '').toLowerCase() !== 'confirmed') {
    return { success: false, error: 'not_active', message: 'That booking is not active any more.' };
  }
  var newStart = parseWhen_(params.new_start_datetime);
  if (!newStart) {
    return { success: false, error: 'bad_datetime', message: 'Sorry, I did not catch the new date and time.' };
  }
  var service = serviceById_(target.service_id);
  if (!service) {
    return { success: false, error: 'unknown_service', message: 'That service is no longer on our list, sorry.' };
  }
  var addonIds = String(target.addons || '').split(';').filter(function (s) { return s.trim() !== ''; });
  var resolved = computeDuration_(service, addonIds);

  return withLock_(function () {
    var cfg = getConfig_();
    var win = dayWindow_(ymd_(newStart));
    var start = win.closed ? newStart : snapToGrid_(newStart, win, Number(cfg.slot_granularity_minutes || 30));
    var check = validateSlot_(start, service, resolved.duration_minutes, target.booking_id);
    if (!check.ok) {
      var alts = alternativesFor_(service, addonIds, check.date, null);
      return {
        success: false,
        error: check.reason,
        alternatives: alts,
        message: 'I cannot move it to then. ' +
          (alts.length ? 'I could do ' + alts.map(function (s) { return s.label; }).join(', ') + '.' : 'Would another day suit?')
      };
    }

    setCell_('Bookings', target._row, 'start_datetime', iso_(check.start));
    setCell_('Bookings', target._row, 'end_datetime', iso_(check.end));

    var eventId = String(target.calendar_event_id || '');
    if (eventId) {
      try {
        var cal = CalendarApp.getCalendarById(cfg.calendar_id);
        var ev = cal.getEventById(eventId);
        if (ev) ev.setTime(check.start, check.end);
      } catch (err) {
        logCall_('reschedule_booking', '', { event_id: eventId }, { error: String(err) }, 'calendar_error');
      }
    }

    return {
      success: true,
      booking_id: String(target.booking_id).trim(),
      start_datetime: iso_(check.start),
      end_datetime: iso_(check.end),
      label: slotLabel_(check.start),
      message: 'Done. Your ' + service.service_name.toLowerCase() + ' is now on ' + slotLabel_(check.start) + '.'
    };
  });
}

function cancelBooking_(params) {
  var target = findBooking_(params);
  if (!target) {
    return { success: false, error: 'not_found', message: 'I could not find that booking, sorry.' };
  }
  if (String(target.status || '').toLowerCase() !== 'confirmed') {
    return { success: false, error: 'not_active', message: 'That booking is already cancelled.' };
  }
  return withLock_(function () {
    var cfg = getConfig_();
    var bookingId = String(target.booking_id).trim();
    setCell_('Bookings', target._row, 'status', 'Cancelled');
    var when = parseWhen_(target.start_datetime);
    var calendarNote = '';

    var eventId = String(target.calendar_event_id || '');
    if (eventId) {
      try {
        var cal = CalendarApp.getCalendarById(cfg.calendar_id);
        var ev = cal.getEventById(eventId);
        if (ev) ev.deleteEvent();
      } catch (err) {
        calendarNote = ' calendar_delete_failed';
        logCall_('cancel_booking', '', { event_id: eventId }, { error: String(err) }, 'calendar_error');
      }
    }

    return {
      success: true,
      booking_id: bookingId,
      status: 'Cancelled',
      was_on: when ? slotLabel_(when) : String(target.start_datetime),
      calendar_deleted: !calendarNote,
      message: 'That is cancelled. Thanks for letting us know.'
    };
  });
}
