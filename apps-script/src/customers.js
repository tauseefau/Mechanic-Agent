/**
 * customers.js — phone-keyed customer + vehicle records.
 */

function findCustomerByPhone_(phone) {
  var target = normalisePhone_(phone);
  if (!target) return null;
  var rows = readTab_('Customers');
  for (var i = 0; i < rows.length; i++) {
    if (normalisePhone_(rows[i].phone) === target) return rows[i];
  }
  return null;
}

function nextId_(tabName, idColumn, prefix) {
  var rows = readTab_(tabName);
  var max = 0;
  rows.forEach(function (r) {
    var v = String(r[idColumn] || '');
    var m = v.match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  var width = tabName === 'Bookings' ? 5 : 4;
  var n = String(max + 1);
  while (n.length < width) n = '0' + n;
  return prefix + n;
}

function findVehicle_(customerId, rego) {
  var want = String(rego || '').replace(/\s+/g, '').toUpperCase();
  var rows = readTab_('Vehicles');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].customer_id).trim() !== String(customerId).trim()) continue;
    if (String(rows[i].rego || '').replace(/\s+/g, '').toUpperCase() === want) return rows[i];
  }
  return null;
}

/** Create or update the customer, return the row with customer_id. */
function upsertCustomer_(input) {
  var phone = normalisePhone_(input.phone);
  var existing = findCustomerByPhone_(phone);
  var nowIso = iso_(new Date());

  if (existing) {
    var patch = { last_contact: nowIso };
    if (input.name && !String(existing.full_name || '').trim()) patch.full_name = input.name;
    if (input.email && !String(existing.email || '').trim()) patch.email = input.email;
    Object.keys(patch).forEach(function (col) {
      setCell_('Customers', existing._row, col, patch[col]);
    });
    existing.last_contact = nowIso;
    return { customer: existing, created: false };
  }

  var customerId = nextId_('Customers', 'customer_id', 'CUS');
  var row = {
    customer_id: customerId,
    full_name: input.name || 'Caller',
    phone: phone,
    email: input.email || '',
    first_seen: nowIso,
    last_contact: nowIso,
    notes: input.notes || ''
  };
  appendObject_('Customers', row);
  return { customer: row, created: true };
}

function upsertVehicle_(customerId, input) {
  var rego = String(input.rego || '').replace(/\s+/g, '').toUpperCase();
  if (!rego) return { vehicle: null, created: false };
  var existing = findVehicle_(customerId, rego);
  if (existing) {
    var patch = {};
    if (input.odometer && !existing.odometer) patch.odometer = input.odometer;
    if (input.notes) patch.notes = input.notes;
    Object.keys(patch).forEach(function (col) { setCell_('Vehicles', existing._row, col, patch[col]); });
    return { vehicle: existing, created: false };
  }
  var vehicleId = nextId_('Vehicles', 'vehicle_id', 'VEH');
  var row = {
    vehicle_id: vehicleId,
    customer_id: customerId,
    rego: rego,
    make: input.make || '',
    model: input.model || '',
    year: input.year || '',
    odometer: input.odometer || '',
    last_service_date: '',
    notes: input.notes || ''
  };
  appendObject_('Vehicles', row);
  return { vehicle: row, created: true };
}

/** Upcoming confirmed bookings for a customer. */
function upcomingBookings_(customerId) {
  var now = new Date().getTime();
  return readTab_('Bookings')
    .filter(function (b) {
      return String(b.customer_id).trim() === String(customerId).trim() &&
        String(b.status || '').trim().toLowerCase() === 'confirmed';
    })
    .map(function (b) {
      var start = parseWhen_(b.start_datetime);
      return {
        booking_id: String(b.booking_id).trim(),
        service_id: String(b.service_id).trim(),
        start_datetime: start ? iso_(start) : String(b.start_datetime),
        label: start ? slotLabel_(start) : String(b.start_datetime),
        addons: String(b.addons || ''),
        _start: start ? start.getTime() : 0
      };
    })
    .filter(function (b) { return b._start >= now - 3600000; })
    .sort(function (a, b) { return a._start - b._start; })
    .map(function (b) { delete b._start; return b; });
}

function lookupCustomer_(params) {
  var phone = normalisePhone_(params.phone);
  if (!isValidPhone_(phone)) {
    return { success: false, error: 'invalid_phone', message: 'Sorry, I did not get a valid number for that.' };
  }
  var customer = findCustomerByPhone_(phone);
  if (!customer) {
    return {
      success: true,
      known: false,
      customer: null,
      vehicles: [],
      upcoming_bookings: [],
      message: 'I do not have that number on file yet, so this is a new customer.'
    };
  }

  var vehicles = readTab_('Vehicles')
    .filter(function (v) { return String(v.customer_id).trim() === String(customer.customer_id).trim(); })
    .map(function (v) {
      return {
        vehicle_id: String(v.vehicle_id).trim(),
        rego: String(v.rego || '').trim().toUpperCase(),
        make: String(v.make || '').trim(),
        model: String(v.model || '').trim(),
        year: v.year || ''
      };
    });

  var upcoming = upcomingBookings_(customer.customer_id);
  var first = String(customer.full_name || '').split(' ')[0];
  var vehicleBit = vehicles.length ? ' Is this about the ' + [vehicles[0].make, vehicles[0].model].filter(Boolean).join(' ') + '?' : '';
  var bookingBit = upcoming.length ? ' You already have ' + upcoming[0].label + ' booked.' : '';

  return {
    success: true,
    known: true,
    customer: {
      customer_id: String(customer.customer_id),
      full_name: String(customer.full_name || ''),
      phone: normalisePhone_(customer.phone),
      email: String(customer.email || '')
    },
    vehicles: vehicles,
    upcoming_bookings: upcoming,
    message: 'Welcome back, ' + first + '.' + vehicleBit + bookingBit
  };
}
