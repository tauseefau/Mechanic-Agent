/**
 * sheet/create_sheet.gs
 * ---------------------------------------------------------------------------
 * Builds the entire "Workshop Voice Agent" spreadsheet from scratch:
 * 10 tabs, frozen bold header rows, filters, data validation, number formats,
 * column widths, seed data and the owner README tab.
 *
 * This file is the Apps Script twin of scripts/build-sheet.py. Both implement
 * sheet/schema.md and carry the same seed rows, so a new workshop can be built
 * from a browser (this file) or from a terminal (the Python script).
 *
 * HOW TO USE
 *   1. Create a blank spreadsheet: https://sheets.new
 *   2. Extensions > Apps Script, replace Code.gs with this file.
 *   3. Run createWorkshopSheet() once and authorise the prompts.
 *   4. Copy the spreadsheet ID from the URL into .env as SHEET_ID.
 *
 * Safe to re-run: existing tabs are reused, data is rewritten, Sheet1 is removed.
 * It does NOT delete customer rows that are already there — delete those by hand.
 */

var HEADER_BG = '#1F3A5F';
var ACCENT = {
  config: '#D98C19',
  catalogue: '#1C7259',
  data: '#334C8C',
  log: '#595959'
};

/** tab specs: [header, type, width]. type: text|number|money|date|datetime|bool|enum:... */
var TABS = [
  {
    name: 'Config',
    group: 'config',
    cols: [
      ['key', 'text', 190],
      ['value', 'text', 420],
      ['notes', 'text', 480]
    ],
    rows: [
      ['workshop_name', 'Riverbend Auto Service', 'PLACEHOLDER - name the agent says when answering'],
      ['phone', '+61390000000', 'PLACEHOLDER - workshop landline quoted to callers'],
      ['address', '12 Example Rd, Melbourne VIC 3000', 'PLACEHOLDER - quoted for directions'],
      ['timezone', 'Australia/Melbourne', 'IANA timezone used for all date maths'],
      ['currency', 'AUD', 'ISO 4217 currency code'],
      ['slot_granularity_minutes', 30, 'Slot grid in minutes (30 = 8:00 8:30 9:00 ...)'],
      ['booking_lead_time_hours', 4, 'Minimum notice in hours before a slot can be booked'],
      ['max_days_ahead', 60, 'How far into the future the agent will book'],
      ['bays_available', 2, 'How many cars can be worked on at once (overlapping bookings allowed)'],
      ['buffer_minutes_between_jobs', 15, 'Cleanup time counted as busy after each job'],
      ['calendar_id', '', 'Paste the Workshop Bookings calendar ID here'],
      ['greeting_name_for_agent', 'Ava', 'Name the agent uses for itself'],
      ['transfer_phone_number', '+61400000000', 'PLACEHOLDER - emergencies and give-me-a-human transfers'],
      ['after_hours_message',
        'Thanks for calling after hours. We are open Monday to Friday eight till five, and Saturday mornings. I can still book you in now.',
        'Said when the caller rings outside opening hours'],
      ['gst_percent', 10, 'GST rate applied to quotes when prices do not include GST'],
      ['prices_include_gst', 'TRUE', 'TRUE = prices in Services/Products already include GST'],
      ['currency_symbol', '$', 'Symbol used when the agent speaks a price'],
      ['phone_country_code', 61, 'Country code used to normalise local numbers to E.164'],
      ['cancellation_policy_text',
        'You can cancel or move a booking any time up to twenty four hours before, at no charge. Inside twenty four hours we may charge a small fee.',
        'Read out when a caller asks about cancelling']
    ]
  },
  {
    name: 'Working_Hours',
    group: 'config',
    cols: [
      ['day_of_week', 'enum:Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday', 130],
      ['open', 'text', 90],
      ['close', 'text', 90],
      ['is_closed', 'bool', 90],
      ['lunch_start', 'text', 100],
      ['lunch_end', 'text', 100]
    ],
    rows: [
      ['Monday', '08:00', '17:00', false, '12:00', '12:30'],
      ['Tuesday', '08:00', '17:00', false, '12:00', '12:30'],
      ['Wednesday', '08:00', '17:00', false, '12:00', '12:30'],
      ['Thursday', '08:00', '17:00', false, '12:00', '12:30'],
      ['Friday', '08:00', '17:00', false, '12:00', '12:30'],
      ['Saturday', '08:00', '12:00', false, '', ''],
      ['Sunday', '09:00', '17:00', true, '', '']
    ]
  },
  {
    name: 'Holidays_Closures',
    group: 'config',
    cols: [
      ['date', 'date', 110],
      ['reason', 'text', 260],
      ['full_day', 'bool', 90],
      ['open', 'text', 90],
      ['close', 'text', 90]
    ],
    rows: [
      ['2026-12-25', 'Christmas Day', true, '', ''],
      ['2026-12-26', 'Boxing Day', true, '', ''],
      ['2027-01-01', "New Year's Day", true, '', ''],
      ['2026-12-24', 'Christmas Eve - early close', false, '08:00', '12:00']
    ]
  },
  {
    name: 'Services',
    group: 'catalogue',
    cols: [
      ['service_id', 'text', 100],
      ['service_name', 'text', 180],
      ['category', 'enum:Servicing,Repairs,Inspection,Tyres,Electrical', 130],
      ['description', 'text', 460],
      ['price_from', 'money', 110],
      ['price_to', 'money', 110],
      ['duration_minutes', 'number', 130],
      ['requires_full_day', 'bool', 120],
      ['active', 'bool', 80],
      ['notes', 'text', 300]
    ],
    rows: [
      ['SVC001', 'General Checkup', 'Servicing',
        'A quick safety and fluid check while you wait.', 49, 79, 30, false, true,
        'PLACEHOLDER pricing - owner to edit'],
      ['SVC002', 'Minor Service', 'Servicing',
        'Oil and filter change, fluids topped up and a basic safety inspection.', 180, 260, 90, false, true,
        'PLACEHOLDER pricing - owner to edit'],
      ['SVC003', 'Major Service', 'Servicing',
        'Full service to the manufacturer schedule including filters, all fluids and a detailed inspection.',
        480, 750, 240, false, true,
        'PLACEHOLDER pricing - owner to edit; car stays with us for the day']
    ]
  },
  {
    name: 'Products_Addons',
    group: 'catalogue',
    cols: [
      ['item_id', 'text', 100],
      ['item_name', 'text', 200],
      ['category', 'enum:Parts,Labour,Consumables,Electrical,Tyres', 130],
      ['price', 'money', 100],
      ['extra_duration_minutes', 'number', 150],
      ['applies_to_services', 'text', 220],
      ['active', 'bool', 80],
      ['notes', 'text', 300]
    ],
    rows: [
      ['ADD001', 'Battery replacement', 'Parts', 220, 30, '', true, ''],
      ['ADD002', 'Wiper blades', 'Parts', 45, 10, '', true, ''],
      ['ADD003', 'Tyre rotation', 'Tyres', 40, 30, '', true, ''],
      ['ADD004', 'Brake pad replacement', 'Parts', 280, 90, 'Minor Service;Major Service', true, ''],
      ['ADD005', 'Air filter', 'Parts', 55, 15, 'Minor Service;Major Service', true, ''],
      ['ADD006', 'Cabin filter', 'Parts', 65, 20, 'Minor Service;Major Service', true, '']
    ]
  },
  {
    name: 'Customers',
    group: 'data',
    cols: [
      ['customer_id', 'text', 110],
      ['full_name', 'text', 200],
      ['phone', 'text', 150],
      ['email', 'text', 240],
      ['first_seen', 'datetime', 150],
      ['last_contact', 'datetime', 150],
      ['notes', 'text', 380]
    ],
    rows: [
      ['CUS0001', 'Sample Customer', '+61400000001', 'sample.customer@example.com',
        '2026-01-05T09:12:00', '2026-01-05T09:12:00',
        'SAMPLE ROW - no real person; delete before go-live'],
      ['CUS0002', 'Second Sample', '+61400000002', '', '2026-02-11T14:40:00', '2026-02-11T14:40:00',
        'SAMPLE ROW - no real person; delete before go-live']
    ]
  },
  {
    name: 'Vehicles',
    group: 'data',
    cols: [
      ['vehicle_id', 'text', 110],
      ['customer_id', 'text', 110],
      ['rego', 'text', 110],
      ['make', 'text', 130],
      ['model', 'text', 150],
      ['year', 'number', 80],
      ['odometer', 'number', 110],
      ['last_service_date', 'date', 140],
      ['notes', 'text', 320]
    ],
    rows: [
      ['VEH0001', 'CUS0001', 'ABC123', 'Toyota', 'Corolla', 2018, 84210, '2025-11-02',
        'SAMPLE ROW - delete before go-live'],
      ['VEH0002', 'CUS0002', 'XYZ789', 'Ford', 'Ranger', 2021, 39150, '2026-01-20',
        'SAMPLE ROW - delete before go-live']
    ]
  },
  {
    name: 'Bookings',
    group: 'data',
    cols: [
      ['booking_id', 'text', 110],
      ['created_at', 'datetime', 150],
      ['customer_id', 'text', 110],
      ['vehicle_id', 'text', 110],
      ['service_id', 'text', 100],
      ['addons', 'text', 160],
      ['start_datetime', 'datetime', 150],
      ['end_datetime', 'datetime', 150],
      ['estimated_price_low', 'money', 150],
      ['estimated_price_high', 'money', 150],
      ['status', 'enum:Confirmed,Cancelled,Completed,No-show', 120],
      ['calendar_event_id', 'text', 220],
      ['source', 'enum:phone,walk-in,web,manual', 110],
      ['notes', 'text', 320]
    ],
    rows: []
  },
  {
    name: 'Call_Log',
    group: 'log',
    cols: [
      ['timestamp', 'datetime', 150],
      ['call_id', 'text', 200],
      ['caller_number', 'text', 150],
      ['tool_called', 'text', 160],
      ['request_json', 'text', 420],
      ['response_json', 'text', 420],
      ['outcome', 'text', 140]
    ],
    rows: []
  },
  {
    name: 'README',
    group: 'config',
    cols: [['A', 'text', 900]],
    rows: []
  }
];

var README_LINES = [
  'WORKSHOP VOICE AGENT - OWNER INSTRUCTIONS',
  '',
  'The AI receptionist reads every number it quotes from this spreadsheet. You never need to touch code.',
  '',
  'CHANGE OPENING HOURS',
  '  Open the Working_Hours tab. One row per weekday. Use 24-hour times, eg 08:00 and 17:30.',
  '  Set is_closed to TRUE to close a whole day. Leave lunch blank if you do not take a break.',
  '',
  'CHANGE A PRICE OR DURATION',
  '  Open the Services tab and edit price_from, price_to or duration_minutes.',
  '  The agent quotes a range when price_from and price_to differ. Set active to FALSE to hide a service.',
  '',
  'ADD A NEW PRODUCT OR ADD-ON',
  '  Open Products_Addons and add a row at the bottom. item_id must be unique. applies_to_services is a',
  '  semicolon list of service names, or blank for any service. extra_duration_minutes is added to the job.',
  '  The agent picks it up on the next call - no code change, no restart.',
  '',
  'BLOCK A HOLIDAY OR A DAY OFF',
  '  Open Holidays_Closures and add a row: date as YYYY-MM-DD, a reason the agent can say aloud, and',
  '  full_day TRUE for a whole day off. For an early close set full_day FALSE and give open/close times.',
  '',
  'SEE YOUR BOOKINGS',
  "  Every booking also appears in the 'Workshop Bookings' Google Calendar with the customer, rego,",
  '  add-ons and estimated price in the event description. The Bookings tab is the same data in table form.',
  '  After the job, set status to Completed or No-show yourself.',
  '',
  'LOOK UP A CUSTOMER',
  '  The Customers tab is keyed by phone number in international format, eg +61412345678.',
  '  Vehicles are in the Vehicles tab using the same customer_id. The agent greets returning callers by name.',
  '',
  'WHAT THE AGENT WILL NEVER DO',
  '  It never quotes a price that is not in Services or Products_Addons.',
  '  It never books outside Working_Hours or on a Holidays_Closures date.',
  '  It never diagnoses a fault. For brakes failing, smoke, an accident or a breakdown it transfers the call',
  '  to transfer_phone_number in the Config tab.',
  '',
  'IF SOMETHING LOOKS WRONG',
  '  1. Check the Call_Log tab - every call and tool request is there with the exact response.',
  '  2. Check that the date is not blocked in Holidays_Closures.',
  '  3. If the agent says it cannot reach the booking system, the web app deployment needs attention.',
  '',
  'Full guide: docs/owner-guide.md in the Mechanic-Agent repository.'
];

/** Main entry point. */
function createWorkshopSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  TABS.forEach(function (tab, i) {
    var sh = ss.getSheetByName(tab.name);
    if (!sh) {
      sh = ss.insertSheet(tab.name, i);
    }
    buildTab_(sh, tab);
    SpreadsheetApp.flush();
  });

  var leftover = ss.getSheetByName('Sheet1');
  if (leftover && leftover.getLastRow() <= 1 && ss.getSheets().length > TABS.length) {
    ss.deleteSheet(leftover);
  }

  SpreadsheetApp.getActive().toast('Workshop Voice Agent sheet built.', 'Done', 5);
  return ss.getId();
}

/** Build (or rebuild) a single tab. */
function buildTab_(sh, tab) {
  var nCols = tab.cols.length;
  var values;

  if (tab.name === 'README') {
    values = README_LINES.map(function (l) { return [l]; });
  } else {
    values = [tab.cols.map(function (c) { return c[0]; })];
    for (var r = 0; r < tab.rows.length; r++) {
      values.push(tab.rows[r]);
    }
  }

  sh.getRange(1, 1, values.length, nCols).setValues(normalise_(values, nCols));

  sh.setFrozenRows(1);
  sh.setTabColor(ACCENT[tab.group] || HEADER_BG);
  sh.getRange(1, 1, 1, nCols)
    .setBackground(HEADER_BG)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setVerticalAlignment('middle');

  for (var c = 0; c < nCols; c++) {
    var spec = tab.cols[c];
    sh.setColumnWidth(c + 1, spec[2]);
    applyFormat_(sh, c + 1, spec[1]);
    applyValidation_(sh, c + 1, spec[1]);
  }

  if (tab.name !== 'README') {
    var existing = sh.getFilter();
    if (existing) { existing.remove(); }
    sh.getRange(1, 1, Math.max(values.length, 1), nCols).createFilter();
  } else {
    sh.getRange(1, 1, 2, 1).setFontSize(12).setFontWeight('bold');
    sh.setColumnWidth(1, 900);
  }
}

function normalise_(rows, nCols) {
  return rows.map(function (r) {
    var out = r.slice(0, nCols);
    while (out.length < nCols) { out.push(''); }
    return out;
  });
}

function applyFormat_(sh, col, type) {
  var fmt = { money: '$#,##0.00', date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm', number: '0' }[type];
  if (!fmt) { return; }
  sh.getRange(2, col, 999, 1).setNumberFormat(fmt);
}

function applyValidation_(sh, col, type) {
  var range = sh.getRange(2, col, 999, 1);
  if (type === 'bool') {
    range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(true).build());
  } else if (type.indexOf('enum:') === 0) {
    var list = type.substring(5).split(',');
    range.setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(list, true)
        .setAllowInvalid(false)
        .setHelpText('Choose one of: ' + list.join(', '))
        .build()
    );
  }
}

/** Rebuild only the README tab from README_LINES. */
function refreshReadmeTab() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('README') || ss.insertSheet('README');
  sh.clear();
  sh.getRange(1, 1, README_LINES.length, 1).setValues(README_LINES.map(function (l) { return [l]; }));
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 2, 1).setFontSize(12).setFontWeight('bold');
  sh.setColumnWidth(1, 900);
}
