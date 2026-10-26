/**
 * config.js — everything workshop-specific, read live from the sheet.
 * Business values never appear here; only defaults for missing keys.
 */

var _CONFIG = null;

var CONFIG_DEFAULTS = {
  timezone: 'Australia/Melbourne',
  currency: 'AUD',
  currency_symbol: '$',
  slot_granularity_minutes: 30,
  booking_lead_time_hours: 4,
  max_days_ahead: 60,
  bays_available: 2,
  buffer_minutes_between_jobs: 15,
  gst_percent: 10,
  prices_include_gst: true,
  phone_country_code: 61,
  greeting_name_for_agent: 'Ava',
  workshop_name: 'the workshop'
};

function getConfig_() {
  if (_CONFIG) return _CONFIG;
  var out = {};
  readTab_('Config').forEach(function (row) {
    var key = String(row.key || '').trim();
    if (!key) return;
    out[key] = coerce_(row.value);
  });
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    if (out[k] === undefined || out[k] === '') out[k] = CONFIG_DEFAULTS[k];
  });
  _CONFIG = out;
  return out;
}

function coerce_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  var s = String(value).trim();
  if (s === '') return '';
  var upper = s.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function cfgNum_(key) { return Number(getConfig_()[key]); }
function cfgBool_(key) { return getConfig_()[key] === true; }
function cfgStr_(key) { return String(getConfig_()[key] === undefined ? '' : getConfig_[key]); }

/** Active services, numeric fields coerced. */
function services_() {
  return readTab_('Services')
    .filter(function (s) { return s.active === true || String(s.active).toUpperCase() === 'TRUE'; })
    .map(function (s) {
      return {
        service_id: String(s.service_id).trim(),
        service_name: String(s.service_name).trim(),
        category: String(s.category || '').trim(),
        description: String(s.description || '').trim(),
        price_from: Number(s.price_from || 0),
        price_to: Number(s.price_to || s.price_from || 0),
        duration_minutes: Number(s.duration_minutes || 0),
        requires_full_day: s.requires_full_day === true || String(s.requires_full_day).toUpperCase() === 'TRUE',
        notes: String(s.notes || '')
      };
    });
}

function serviceById_(id) {
  var key = String(id || '').trim().toUpperCase();
  var list = services_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].service_id.toUpperCase() === key) return list[i];
  }
  // allow matching on the spoken name too
  for (var j = 0; j < list.length; j++) {
    if (list[j].service_name.toLowerCase() === String(id || '').trim().toLowerCase()) return list[j];
  }
  return null;
}

function addons_() {
  return readTab_('Products_Addons')
    .filter(function (a) { return a.active === true || String(a.active).toUpperCase() === 'TRUE'; })
    .map(function (a) {
      return {
        item_id: String(a.item_id).trim(),
        item_name: String(a.item_name).trim(),
        category: String(a.category || '').trim(),
        price: Number(a.price || 0),
        extra_duration_minutes: Number(a.extra_duration_minutes || 0),
        applies_to_services: String(a.applies_to_services || '').trim(),
        notes: String(a.notes || '')
      };
    });
}

function addonById_(id) {
  var key = String(id || '').trim().toUpperCase();
  var list = addons_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].item_id.toUpperCase() === key) return list[i];
  }
  for (var j = 0; j < list.length; j++) {
    if (list[j].item_name.toLowerCase() === String(id || '').trim().toLowerCase()) return list[j];
  }
  return null;
}

/** Add-ons that may be sold with a service (blank applies_to_services = any). */
function addonsForService_(serviceName) {
  var name = String(serviceName || '').toLowerCase();
  return addons_().filter(function (a) {
    if (!a.applies_to_services) return true;
    return a.applies_to_services.split(';').some(function (s) {
      return s.trim().toLowerCase() === name;
    });
  });
}

/** Working hours keyed by weekday name. */
function workingHours_() {
  var out = {};
  readTab_('Working_Hours').forEach(function (row) {
    var day = String(row.day_of_week || '').trim();
    if (!day) return;
    out[day] = {
      day_of_week: day,
      open: String(row.open || '').trim(),
      close: String(row.close || '').trim(),
      is_closed: row.is_closed === true || String(row.is_closed).toUpperCase() === 'TRUE',
      lunch_start: String(row.lunch_start || '').trim(),
      lunch_end: String(row.lunch_end || '').trim()
    };
  });
  return out;
}

/** Closure row for a yyyy-MM-dd, or null. */
function holidayFor_(dateStr) {
  var rows = readTab_('Holidays_Closures');
  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i].date;
    var value = raw instanceof Date ? ymd_(raw) : String(raw).trim();
    if (value === dateStr) {
      return {
        date: value,
        reason: String(rows[i].reason || '').trim() || 'closed',
        full_day: rows[i].full_day === true || String(rows[i].full_day).toUpperCase() === 'TRUE',
        open: String(rows[i].open || '').trim(),
        close: String(rows[i].close || '').trim()
      };
    }
  }
  return null;
}

/** Public shape of workshop info (no personal data). */
function workshopInfo_() {
  var cfg = getConfig_();
  var hours = workingHours_();
  var order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var closures = readTab_('Holidays_Closures').map(function (r) {
    return {
      date: r.date instanceof Date ? ymd_(r.date) : String(r.date).trim(),
      reason: String(r.reason || '').trim(),
      full_day: r.full_day === true || String(r.full_day).toUpperCase() === 'TRUE'
    };
  }).filter(function (c) { return c.date; });

  return {
    workshop_name: cfg.workshop_name,
    phone: String(cfg.phone || ''),
    address: String(cfg.address || ''),
    timezone: cfg.timezone,
    currency: cfg.currency,
    agent_name: cfg.greeting_name_for_agent,
    after_hours_message: String(cfg.after_hours_message || ''),
    cancellation_policy_text: String(cfg.cancellation_policy_text || ''),
    gst_percent: cfg.gst_percent,
    prices_include_gst: cfg.prices_include_gst === true,
    hours: order.filter(function (d) { return hours[d]; }).map(function (d) {
      var h = hours[d];
      return { day: d, open: h.open, close: h.close, closed: h.is_closed, lunch_start: h.lunch_start, lunch_end: h.lunch_end };
    }),
    closures: closures
  };
}

function servicesPublic_() {
  var cfg = getConfig_();
  return {
    services: services_().map(function (s) {
      return {
        service_id: s.service_id,
        service_name: s.service_name,
        category: s.category,
        description: s.description,
        price_range: priceRange_(s.price_from, s.price_to, cfg),
        price_from: s.price_from,
        price_to: s.price_to,
        duration_minutes: s.duration_minutes,
        requires_full_day: s.requires_full_day
      };
    }),
    addons: addons_().map(function (a) {
      return {
        item_id: a.item_id,
        item_name: a.item_name,
        category: a.category,
        price: a.price,
        extra_duration_minutes: a.extra_duration_minutes,
        applies_to_services: a.applies_to_services
      };
    })
  };
}
