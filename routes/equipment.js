const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { db, tx } = require('../lib/db');
const audit = require('../lib/audit');
const site = require('../lib/site');
const cal = require('../lib/calibration');
const {
  isValidDate, todayStr, formatDate, formatMonth, formatPeriod, dueDate, relative, formatDateTime, DEFAULT_PERIOD, MAX_PERIOD,
} = require('../lib/dates');
const { h, icon, combo, layout, statusTag, statusOf, alert, pageHead, FIELDS, detailRows, detailTables, soonDays } = require('../lib/views');
const lists = require('../lib/lists');
const { field, requirePerm, notFound } = require('../lib/http');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const scanUrl = (req, eq) => `${site.baseUrl(req)}/e/${eq.public_id}`;
const getEquipment = (id) => db.prepare('SELECT * FROM equipment WHERE id = ?').get(Number(id));

// ============================================================ filters
// Exact-match dropdowns (values come from the data), and "contains" text boxes.
const SELECT_FILTERS = [
  ['owner', 'Owner'], ['department', 'Department'], ['type', 'Type of equipment'], ['manufacturer', 'Manufacturer'],
  ['calibrated_by', 'Calibrated by'], ['procedure', 'Procedure'], ['cal_period', 'Calibration period'], ['result', 'Result'],
];
const TEXT_FILTERS = [['cert_no', 'Certificate number'], ['serial_no', 'Serial number'], ['cal_range', 'Range'], ['remarks', 'Remarks']];
const DATE_FILTERS = [['cal_from', 'Calibrated from'], ['cal_to', 'Calibrated to'], ['due_from', 'Due from'], ['due_to', 'Due to']];
const SEARCH_COLS = ['cert_no', 'owner', 'department', 'type', 'serial_no', 'manufacturer', 'cal_range', 'calibrated_by', 'procedure', 'remarks', 'contact_email', 'notes'];
const FILTER_KEYS = ['q', 'status', ...SELECT_FILTERS.map((x) => x[0]), ...TEXT_FILTERS.map((x) => x[0]), ...DATE_FILTERS.map((x) => x[0])];

function filtersFrom(query) {
  const f = {};
  for (const k of FILTER_KEYS) f[k] = typeof query[k] === 'string' ? query[k].trim().slice(0, 200) : '';
  if (!['', 'valid', 'due-soon', 'overdue', 'unfit'].includes(f.status)) f.status = '';
  for (const k of ['cal_from', 'cal_to']) if (f[k] && !isValidDate(f[k])) f[k] = '';
  for (const k of ['due_from', 'due_to']) if (f[k] && !/^\d{4}-\d{2}$/.test(f[k])) f[k] = '';
  return f;
}

const likeOf = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// All filters except status (so the status tiles can count within the other filters).
function findEquipment(f, { ignoreStatus = false } = {}) {
  let sql = 'SELECT * FROM equipment WHERE 1=1';
  const params = [];
  if (f.q) {
    sql += ` AND (${SEARCH_COLS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    params.push(...SEARCH_COLS.map(() => likeOf(f.q)));
  }
  for (const [col] of SELECT_FILTERS) {
    if (!f[col]) continue;
    if (col === 'result' && f[col] === 'none') { sql += " AND result = ''"; continue; }
    sql += ` AND ${col} = ?`;
    params.push(col === 'cal_period' ? Number(f[col]) : f[col]);
  }
  for (const [col] of TEXT_FILTERS) if (f[col]) { sql += ` AND ${col} LIKE ? ESCAPE '\\'`; params.push(likeOf(f[col])); }
  if (f.cal_from) { sql += ' AND cal_date >= ?'; params.push(f.cal_from); }
  if (f.cal_to) { sql += ' AND cal_date <= ?'; params.push(f.cal_to); }
  sql += ' ORDER BY cal_date ASC, cert_no COLLATE NOCASE';
  let rows = db.prepare(sql).all(...params);
  // The due month is calculated, so filter it here.
  if (f.due_from) rows = rows.filter((e) => dueDate(e.cal_date, e.cal_period).slice(0, 7) >= f.due_from);
  if (f.due_to) rows = rows.filter((e) => dueDate(e.cal_date, e.cal_period).slice(0, 7) <= f.due_to);
  const today = todayStr();
  rows.forEach((e) => { e._status = statusOf(e, today); e._due = dueDate(e.cal_date, e.cal_period); });
  return ignoreStatus || !f.status ? rows : rows.filter((e) => e._status === f.status);
}

const qs = (f, extra = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

function distinct(col) {
  return db.prepare(`SELECT DISTINCT ${col} AS v FROM equipment WHERE ${col} != '' ORDER BY ${col} COLLATE NOCASE LIMIT 500`).all().map((r) => r.v);
}

function filterLabel(k, v) {
  if (k === 'q') return `Search: “${v}”`;
  if (k === 'status') return cal.STATUS_LABELS[v];
  if (k === 'result') return `Result: ${v === 'none' ? 'not recorded' : cal.RESULTS[v] || v}`;
  if (k === 'cal_period') return `Period: ${formatPeriod(v)}`;
  if (k === 'cal_from' || k === 'cal_to') return `${k === 'cal_from' ? 'Calibrated from' : 'Calibrated to'} ${formatDate(v)}`;
  if (k === 'due_from' || k === 'due_to') return `${k === 'due_from' ? 'Due from' : 'Due to'} ${formatMonth(`${v}-01`)}`;
  const def = [...SELECT_FILTERS, ...TEXT_FILTERS].find((x) => x[0] === k);
  return `${def ? def[1] : k}: ${v}`;
}

// ============================================================ register
router.get('/equipment', requirePerm('equipment.view'), (req, res) => {
  const u = req.user;
  const f = filtersFrom(req.query);
  const base = findEquipment(f, { ignoreStatus: true });
  const list = f.status ? base.filter((e) => e._status === f.status) : base;
  const total = db.prepare('SELECT COUNT(*) c FROM equipment').get().c;
  const counts = { valid: 0, 'due-soon': 0, overdue: 0, unfit: 0 };
  for (const e of base) counts[e._status]++;
  const today = todayStr();

  const stat = (key, label) => `
    <a class="s-${key || 'all'} ${f.status === key ? 'active' : ''}" href="/equipment${qs({ ...f, status: key })}">
      <span class="n">${key ? counts[key] : base.length}</span><span class="l">${label}</span>
    </a>`;

  const rows = list.map((e) => `
    <tr>
      <td class="sel"><input type="checkbox" name="ids" value="${e.id}" form="bulk" data-select-row aria-label="Select ${h(e.cert_no)}"></td>
      <td class="nowrap"><a class="cell-link mono" href="/e/${e.public_id}">${h(e.cert_no)}</a></td>
      <td>${h(e.type)}<span class="sub mono">S/N ${h(e.serial_no)}</span>${e.manufacturer || e.cal_range ? `<span class="sub">${h([e.manufacturer, e.cal_range].filter(Boolean).join(' · '))}</span>` : ''}</td>
      <td class="hide-sm">${h(e.owner)}<span class="sub">${h(e.department)}</span></td>
      <td class="nowrap hide-sm">${formatDate(e.cal_date)}<span class="sub">${h(formatPeriod(e.cal_period).replace(/ \(.*\)/, ''))}</span></td>
      <td class="nowrap">${formatMonth(e._due)}<span class="sub">${relative(e._due, today)}</span></td>
      <td>${statusTag(e, today)}</td>
      <td class="actions">
        <a class="btn btn-sm btn-quiet" href="/equipment/${e.id}/label" title="QR label">${icon('qr')}<span class="sr">Label</span></a>
        ${u.can('equipment.edit') ? `<a class="btn btn-sm btn-quiet" href="/equipment/${e.id}/edit" title="Edit">${icon('edit')}<span class="sr">Edit</span></a>` : ''}
      </td>
    </tr>`).join('');

  const active = FILTER_KEYS.filter((k) => f[k]);
  const advanced = active.filter((k) => !['q', 'status'].includes(k));
  const chips = active.map((k) => `<a class="filter-chip" href="/equipment${qs(f, { [k]: '' })}" title="Remove this filter">${h(filterLabel(k, f[k]))}<span aria-hidden="true">×</span></a>`).join('');
  const sel = (col, label) => {
    let opts;
    if (col === 'result') opts = [...Object.entries(cal.RESULTS), ['none', 'Not recorded']];
    else if (col === 'cal_period') opts = distinct('cal_period').map((v) => [String(v), formatPeriod(v)]);
    else opts = distinct(col).map((v) => [v, v]);
    return `<label class="field"><span>${label}</span><select name="${col}"><option value="">Any</option>${opts.map(([v, l]) => `<option value="${h(v)}" ${String(f[col]) === String(v) ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>`;
  };

  const actions = [
    u.can('equipment.export') ? `<a class="btn" href="/equipment/export.csv${qs(f)}">${icon('download')} Export CSV</a>` : '',
    u.can('equipment.edit') ? `<a class="btn" href="/equipment/import">${icon('upload')} Import Excel</a>` : '',
    u.can('equipment.edit') ? `<a class="btn btn-primary" href="/equipment/new">${icon('plus')} Add equipment</a>` : '',
  ].join('');

  res.send(layout({
    req,
    title: 'Register',
    active: 'register',
    wide: true,
    body: `
    ${req.query.imported ? alert(String(req.query.imported).slice(0, 300), 'success') : ''}
    ${pageHead('Equipment register', actions)}
    <nav class="summary ${counts.unfit ? 'five' : ''}" aria-label="Filter by status">
      ${stat('', advanced.length || f.q ? 'Matching' : 'All equipment')}
      ${stat('valid', 'In date')}
      ${stat('due-soon', `Due within ${soonDays()} days`)}
      ${stat('overdue', 'Overdue')}
      ${counts.unfit || f.status === 'unfit' ? stat('unfit', 'Not fit for use') : ''}
    </nav>
    <form class="filters-form" method="get" action="/equipment" role="search">
      <div class="toolbar">
        <div class="search">${icon('search')}<input type="search" name="q" placeholder="Search every field…" value="${h(f.q)}" aria-label="Search"></div>
        <select name="status" aria-label="Status">
          <option value="">Any status</option>
          ${Object.entries(cal.STATUS_LABELS).map(([k, v]) => `<option ${k === f.status ? 'selected' : ''} value="${k}">${v}</option>`).join('')}
        </select>
        <button type="button" class="btn" data-toggle-filters aria-expanded="${advanced.length ? 'true' : 'false'}" aria-controls="more-filters">${icon('filter')} Filters${advanced.length ? ` <span class="count">${advanced.length}</span>` : ''}</button>
        <button class="btn btn-primary">Apply</button>
      </div>
      <div id="more-filters" class="panel more-filters" ${advanced.length ? '' : 'hidden'}>
        <div class="panel-body">
          <div class="filter-grid">
            ${SELECT_FILTERS.map(([c, l]) => sel(c, l)).join('')}
            ${TEXT_FILTERS.map(([c, l]) => `<label class="field"><span>${l} contains</span><input type="text" name="${c}" value="${h(f[c])}"></label>`).join('')}
            <label class="field"><span>Calibrated from</span><input type="date" name="cal_from" value="${h(f.cal_from)}"></label>
            <label class="field"><span>Calibrated to</span><input type="date" name="cal_to" value="${h(f.cal_to)}"></label>
            <label class="field"><span>Due from (month)</span><input type="month" name="due_from" value="${h(f.due_from)}" placeholder="YYYY-MM"></label>
            <label class="field"><span>Due to (month)</span><input type="month" name="due_to" value="${h(f.due_to)}" placeholder="YYYY-MM"></label>
          </div>
        </div>
        <div class="panel-foot"><button class="btn btn-primary">Apply filters</button>${active.length ? '<a class="btn btn-quiet" href="/equipment">Clear all</a>' : ''}</div>
      </div>
    </form>
    ${chips ? `<div class="chips">${chips}<a class="filter-chip clear" href="/equipment">Clear all</a></div>` : ''}
    <section class="panel">
      ${list.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th class="sel"><input type="checkbox" data-select-all aria-label="Select all"></th>
            <th>Certificate</th><th>Equipment</th><th class="hide-sm">Owner</th><th class="hide-sm">Calibrated</th><th>Due</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <form id="bulk" method="get" action="/labels" class="bulk-bar">
        <button class="btn btn-sm" data-bulk-btn disabled>${icon('printer')} Print labels</button>
        <span data-bulk-count></span>
        <span class="muted small" style="margin-left:auto">${list.length} of ${total} item${total === 1 ? '' : 's'}</span>
      </form>` : `
      <div class="empty">
        ${total ? '<h3>No matches</h3><p>No equipment matches these filters.</p><a class="btn" href="/equipment">Clear filters</a>'
          : `<h3>The register is empty</h3><p>Add equipment by hand, or import calibration reports from Excel.</p>${u.can('equipment.edit') ? `<a class="btn" href="/equipment/import">${icon('upload')} Import Excel</a> <a class="btn btn-primary" href="/equipment/new">${icon('plus')} Add equipment</a>` : ''}`}
      </div>`}
    </section>`,
  }));
});

// ============================================================ CSV export
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/equipment/export.csv', requirePerm('equipment.export'), (req, res) => {
  const list = findEquipment(filtersFrom(req.query));
  const base = site.baseUrl(req);
  const cols = [
    ['Certificate number', (e) => e.cert_no], ['Owner', (e) => e.owner], ['Department', (e) => e.department],
    ['Type of equipment', (e) => e.type], ['Serial number', (e) => e.serial_no], ['Manufacturer', (e) => e.manufacturer], ['Range', (e) => e.cal_range],
    ['Date of calibration', (e) => e.cal_date], ['Calibration period (months)', (e) => e.cal_period], ['Calibration due', (e) => formatMonth(e._due)], ['Valid until', (e) => e._due],
    ['Status', (e) => cal.STATUS_LABELS[e._status]], ['Result', (e) => cal.RESULTS[e.result] || ''], ['Calibrated by', (e) => e.calibrated_by],
    ['Procedure', (e) => e.procedure], ['Temperature', (e) => e.temperature], ['Remarks', (e) => e.remarks],
    ['Reference instruments', (e) => cal.parseDetails(e.details).instruments.map((i) => [i.description, i.serial && `S/N ${i.serial}`, i.cert && `cert ${i.cert}`].filter(Boolean).join(' ')).join('; ')],
    ['Contact email', (e) => e.contact_email], ['Notes', (e) => e.notes], ['QR link', (e) => `${base}/e/${e.public_id}`],
  ];
  const lines = [cols.map(([n]) => csvCell(n)).join(',')];
  for (const e of list) lines.push(cols.map(([, fn]) => csvCell(fn(e))).join(','));
  audit.log(req.user, 'Exported CSV', `${list.length} items`);
  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="calibration-register-${todayStr()}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

// ============================================================ reading & saving a record
const OPTIONAL_TEXT = ['manufacturer', 'cal_range', 'calibrated_by', 'procedure', 'temperature', 'remarks', 'source_file'];

function readEquipment(body) {
  const v = {};
  for (const f of FIELDS) v[f.key] = field(body, f.key);
  v.cal_date = field(body, 'cal_date');
  const rawPeriod = field(body, 'cal_period');
  v.cal_period = rawPeriod === '' ? DEFAULT_PERIOD : Number(rawPeriod);
  for (const k of OPTIONAL_TEXT) v[k] = field(body, k);
  v.result = cal.RESULTS[field(body, 'result')] ? field(body, 'result') : '';
  v.contact_email = field(body, 'contact_email').toLowerCase();
  v.notes = field(body, 'notes');
  v.details = JSON.stringify(cal.detailsFromBody(body));
  for (const k of Object.keys(lists.KINDS)) v[k] = lists.canonical(k, v[k]);
  const missing = FIELDS.filter((f) => !v[f.key]).map((f) => f.label.toLowerCase());
  if (missing.length) return { v, error: `Please fill in: ${missing.join(', ')}.` };
  if ([...FIELDS.map((f) => f.key), ...OPTIONAL_TEXT.filter((k) => k !== 'remarks')].some((k) => v[k].length > 200)) return { v, error: 'Each field can be at most 200 characters.' };
  if (!isValidDate(v.cal_date)) return { v, error: 'Please enter a valid date of calibration.' };
  if (v.cal_date > todayStr()) return { v, error: 'The date of calibration can\'t be in the future.' };
  if (!Number.isInteger(v.cal_period) || v.cal_period < 1 || v.cal_period > MAX_PERIOD) {
    return { v, error: `The calibration period must be a whole number of months between 1 and ${MAX_PERIOD}.` };
  }
  if (v.contact_email && !EMAIL_RE.test(v.contact_email)) return { v, error: 'The contact email doesn\'t look right.' };
  if (v.notes.length > 2000 || v.remarks.length > 2000) return { v, error: 'Notes and remarks can be at most 2000 characters.' };
  return { v, error: '' };
}

const COLS = ['public_id', 'cert_no', 'owner', 'department', 'type', 'serial_no', 'cal_date', 'cal_period', 'manufacturer', 'cal_range',
  'calibrated_by', 'procedure', 'temperature', 'result', 'remarks', 'details', 'source_file', 'contact_email', 'notes', 'created_at', 'updated_at'];

function insertEquipment(v) {
  const now = Date.now();
  const row = { ...v, public_id: crypto.randomBytes(9).toString('base64url'), created_at: now, updated_at: now };
  const info = db.prepare(`INSERT INTO equipment (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`).run(...COLS.map((c) => row[c] ?? ''));
  lists.remember(v); // a new type / owner / department appears in the dropdowns from now on
  return info.lastInsertRowid;
}

function updateEquipment(eq, v, { recalibrated, by }) {
  tx(() => {
    if (recalibrated) {
      db.prepare('INSERT INTO calibration_history (equipment_id, cert_no, cal_date, cal_period, recorded_at, recorded_by, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(eq.id, eq.cert_no, eq.cal_date, eq.cal_period, Date.now(), by, cal.snapshotOf(eq));
    }
    const cols = COLS.filter((c) => !['public_id', 'created_at'].includes(c));
    db.prepare(`UPDATE equipment SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => (c === 'updated_at' ? Date.now() : v[c] ?? '')), eq.id);
    lists.remember(v);
  });
}

const findBySerial = (serial, exceptId = 0) => (serial ? db.prepare('SELECT * FROM equipment WHERE serial_no = ? COLLATE NOCASE AND id != ? LIMIT 1').get(serial, exceptId) : null);

// ============================================================ the form

function rowEditor(key, rows, apparatusOptions = []) {
  const t = cal.TABLES[key];
  const label = (c) => t.cols.find((x) => x[0] === c)[1];
  const select = (c, val, opts) => `<select name="${key}.${c}" aria-label="${h(label(c))}">${opts.map((o) => `<option${o === val ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
  const cell = (c, val) => {
    if (key === 'checks' && c === 'done') return select(c, val === 'No' ? 'No' : 'Yes', ['Yes', 'No']);
    if (key === 'readings' && c === 'adjusted') return select(c, cal.adjustedValue(val), cal.ADJUSTED);
    if (key === 'readings' && c === 'section') {
      // Apparatus: pick from the reference instruments listed on this form, or type one.
      return combo({ name: `${key}.${c}`, id: `app-${crypto.randomBytes(4).toString('hex')}`, value: val, options: apparatusOptions, label: 'Apparatus', newLabel: 'Use' })
        .replace('data-combo ', 'data-combo data-options-from="instruments.description" ');
    }
    if (key === 'readings' && c === 'error') {
      const calc = cal.computeError(thisRow.nominal, thisRow.measured) !== null;
      return `<input type="text" name="${key}.${c}" value="${h(val)}" maxlength="200" aria-label="Error (specified minus measured)" data-error ${calc ? 'readonly class="computed-input" title="Calculated: specified − measured"' : ''}>`;
    }
    return `<input type="text" name="${key}.${c}" value="${h(val)}" maxlength="200" aria-label="${h(label(c))}"${key === 'readings' && ['nominal', 'measured'].includes(c) ? ` data-${c}` : ''}>`;
  };
  let thisRow = {};
  const row = (r = {}) => {
    thisRow = r;
    return `<tr>${t.cols.map(([c]) => `<td${key === 'readings' && c === 'section' ? ' style="min-width:190px"' : ''}>${cell(c, r[c] || '')}</td>`).join('')}<td class="actions"><button type="button" class="btn btn-sm btn-quiet" data-row-remove title="Remove row">×</button></td></tr>`;
  };
  return `
    <details class="row-editor" ${rows.length ? 'open' : ''}>
      <summary><span>${t.label}</span> <span class="muted small">${rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : 'none'}</span></summary>
      <div class="table-wrap"><table class="table table-edit">
        <thead><tr>${t.cols.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead>
        <tbody data-rows="${key}">${rows.map(row).join('')}</tbody>
      </table></div>
      <template data-row-template="${key}">${row()}</template>
      <div class="row-editor-foot"><button type="button" class="btn btn-sm" data-row-add="${key}">${icon('plus', 14)} Add row</button></div>
    </details>`;
}

// mode: 'new' | 'edit' | 'recal'
function equipmentForm(req, { mode, values = {}, error = '', notice = '', eq = null, allowDuplicate = false }) {
  const title = mode === 'new' ? 'Add equipment' : mode === 'recal' ? `New calibration for ${eq.serial_no}` : `Edit ${eq.cert_no}`;
  const action = mode === 'new' ? '/equipment/new' : `/equipment/${eq.id}/${mode === 'recal' ? 'recalibrate' : 'edit'}`;
  // Fields with a pick-or-add dropdown, and the label for the "add new" option.
  const DROPDOWNS = { type: 'Add new type', owner: 'Add new owner', department: 'Add new department', manufacturer: 'Add new manufacturer', calibrated_by: 'Use', procedure: 'Use' };
  const details = typeof values.details === 'string' ? cal.parseDetails(values.details) : cal.normaliseDetails(values.details || {});
  const text = (key, label, { mono = false, required = false, hint = '', id = key } = {}) => {
    const hintHtml = hint ? `<span class="hint">${hint}</span>` : '';
    if (DROPDOWNS[key]) {
      return `<div class="field"><label for="${id}" class="computed-label">${label}</label>
        ${combo({ name: key, id, value: values[key], options: lists.values(key), required, mono, label, newLabel: DROPDOWNS[key] })}${hintHtml}</div>`;
    }
    return `
    <label class="field"><span>${label}</span>
      <input type="text" id="${id}" name="${key}" ${required ? 'required' : ''} maxlength="200" value="${h(values[key])}" autocomplete="off"${mono ? ' class="mono"' : ''}>
      ${hintHtml}
    </label>`;
  };
  const back = eq ? `/e/${eq.public_id}` : '/equipment';
  return layout({
    req,
    title,
    active: 'register',
    body: `
    <a class="back" href="${back}">${icon('back', 14)} ${eq ? 'Back to details' : 'Register'}</a>
    ${pageHead(h(title), mode === 'new' ? `<a class="btn" href="/equipment/import">${icon('upload')} Fill from Excel</a>`
      : mode === 'edit' ? `<a class="btn" href="/equipment/${eq.id}/recalibrate">Record new calibration</a><a class="btn" href="/equipment/import?id=${eq.id}">${icon('upload')} From Excel</a>` : '',
    mode === 'recal' ? `${h(eq.type)} · current certificate ${h(eq.cert_no)}, calibrated ${formatDate(eq.cal_date)}. Saving moves that certificate into the history.` : '')}
    ${alert(notice, 'info')}
    <form method="post" action="${action}" class="panel" data-equipment-form>
      <div class="panel-body form">
        ${alert(error)}
        ${values.source_file ? `<input type="hidden" name="source_file" value="${h(values.source_file)}">` : ''}
        ${allowDuplicate ? '<input type="hidden" name="allow_duplicate" value="1">' : ''}
        <div class="form-section-title">Equipment</div>
        <div class="grid-2">
          ${text('cert_no', 'Certificate / report number', { mono: true, required: true })}
          ${text('serial_no', 'Serial number', { mono: true, required: true })}
          ${text('type', 'Type of equipment', { required: true })}
          ${text('manufacturer', 'Manufacturer')}
          ${text('cal_range', 'Range', { hint: 'e.g. 0–150 mm, 0–10 bar' })}
          <span></span>
          ${text('owner', 'Owner', { required: true })}
          ${text('department', 'Department', { required: true })}
        </div>
        <div class="form-section">
          <div class="form-section-title">Calibration</div>
          <div class="grid-2">
            <label class="field"><span>Date of calibration</span><input type="date" id="cal_date" name="cal_date" required max="${todayStr()}" value="${h(values.cal_date)}"></label>
            <div class="field"><label for="cal_period" class="computed-label">Calibration period</label>
              <span class="period-input"><input type="number" id="cal_period" name="cal_period" required min="1" max="${MAX_PERIOD}" step="1" inputmode="numeric"value="${h(values.cal_period ?? DEFAULT_PERIOD)}"><span class="unit">months</span></span>
              <span class="period-presets">${[6, 12, 24, 36, 48, 60].map((m) => `<button type="button" class="chip" data-period="${m}">${m % 12 ? `${m} mo` : `${m / 12} yr`}</button>`).join('')}</span>
            </div>
            <div class="computed" aria-live="polite">
              <span class="computed-label">Calibration due</span>
              <span class="value" data-due-from="cal_date" data-period-from="cal_period">—</span>
              <span class="hint" data-valid-until>Calibration date + period, rounded to the month</span>
            </div>
            <label class="field"><span>Result</span><select name="result">
              <option value="">Not recorded</option>
              ${Object.entries(cal.RESULTS).map(([k, l]) => `<option value="${k}" ${values.result === k ? 'selected' : ''}>${l}</option>`).join('')}
            </select><span class="hint">"Not fit for use" marks the item red, whatever the dates say.</span></label>
            ${text('calibrated_by', 'Calibrated by')}
            ${text('procedure', 'Procedure / work instruction', { mono: true, hint: 'e.g. WI-18-03 Rev 2' })}
            ${text('temperature', 'Temperature', { hint: 'e.g. 19–21 °C' })}
            <label class="field"><span>Remarks</span><textarea name="remarks" maxlength="2000" rows="2">${h(values.remarks)}</textarea></label>
          </div>
          ${mode === 'edit' ? `
          <label class="check" data-history-toggle hidden style="margin-top:14px"><input type="checkbox" name="keep_history" value="1" checked>
            <span>This is a new calibration. Keep the previous certificate (${h(eq.cert_no)}, ${formatDate(eq.cal_date)}) in the history<small>Untick if you're only correcting a typo. Tip: use "Record new calibration" to start with blank calibration details.</small></span></label>` : ''}
        </div>
        <div class="form-section">
          <div class="form-section-title">Calibration report details</div>
          ${Object.keys(cal.TABLES).map((k) => rowEditor(k, details[k] || [], [...new Set((details.instruments || []).map((i) => i.description).filter(Boolean))])).join('')}
        </div>
        <div class="form-section">
          <div class="form-section-title">Optional</div>
          <div class="grid-2">
            <label class="field"><span>Contact email</span><input type="email" name="contact_email" maxlength="200" value="${h(values.contact_email)}"><span class="hint">Can receive reminder emails about this item.</span></label>
            <label class="field"><span>Notes</span><textarea name="notes" maxlength="2000" rows="2">${h(values.notes)}</textarea><span class="hint">Only visible to logged-in users.</span></label>
          </div>
        </div>
      </div>
      <div class="panel-foot">
        <button class="btn btn-primary">${mode === 'new' ? 'Save and create label' : mode === 'recal' ? 'Save new calibration' : 'Save changes'}</button>
        <a class="btn btn-quiet" href="${back}">Cancel</a>
      </div>
    </form>
    ${mode === 'edit' && req.user.can('equipment.delete') ? `
    <section class="panel">
      <div class="panel-head"><h2>Delete this equipment</h2></div>
      <div class="panel-body">
        <p class="muted">Removes the record and its history. Its QR code will stop working.</p>
        <form method="post" action="/equipment/${eq.id}/delete" data-confirm="Delete ${h(eq.cert_no)} permanently? This can't be undone.">
          <button class="btn btn-danger">Delete equipment</button>
        </form>
      </div>
    </section>` : ''}`,
  });
}

// ---------- add ----------
router.get('/equipment/new', requirePerm('equipment.edit'), (req, res) => {
  res.send(equipmentForm(req, { mode: 'new', values: { cal_date: todayStr() } }));
});

router.post('/equipment/new', requirePerm('equipment.edit'), (req, res) => {
  const { v, error } = readEquipment(req.body);
  if (error) return res.status(400).send(equipmentForm(req, { mode: 'new', values: v, error, allowDuplicate: Boolean(req.body.allow_duplicate) }));
  const dup = findBySerial(v.serial_no);
  if (dup && !req.body.allow_duplicate) {
    return res.status(409).send(equipmentForm(req, {
      mode: 'new', values: v, allowDuplicate: true,
      error: `Serial number ${v.serial_no} is already in the register (${dup.cert_no}, ${dup.type}). To add a new certificate for it, open that item and choose "Record new calibration". Press save again only if this really is a different item.`,
    }));
  }
  const id = insertEquipment(v);
  audit.log(req.user, 'Added equipment', `${v.cert_no} · ${v.type} · S/N ${v.serial_no} · ${v.cal_period} months${v.source_file ? ` · from ${v.source_file}` : ''}`);
  res.redirect(`/equipment/${id}/label?new=1`);
});

// ---------- edit ----------
router.get('/equipment/:id/edit', requirePerm('equipment.edit'), (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  res.send(equipmentForm(req, { mode: 'edit', values: eq, eq }));
});

router.post('/equipment/:id/edit', requirePerm('equipment.edit'), (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  const { v, error } = readEquipment(req.body);
  if (error) return res.status(400).send(equipmentForm(req, { mode: 'edit', values: v, error, eq }));
  const recalibrated = Boolean((v.cert_no !== eq.cert_no || v.cal_date !== eq.cal_date) && req.body.keep_history);
  if (!v.source_file) v.source_file = eq.source_file;
  updateEquipment(eq, v, { recalibrated, by: req.user.name });
  const periodNote = v.cal_period !== eq.cal_period ? `; period ${eq.cal_period} → ${v.cal_period} months` : '';
  audit.log(req.user, recalibrated ? 'Recorded new calibration' : 'Edited equipment',
    (recalibrated ? `${eq.cert_no} (${eq.cal_date}) → ${v.cert_no} (${v.cal_date})` : v.cert_no) + periodNote);
  res.redirect(`/e/${eq.public_id}?saved=1`);
});

// ---------- record a new calibration (calibration details start blank) ----------
function recalDefaults(eq) {
  return {
    ...eq, cert_no: '', cal_date: todayStr(), calibrated_by: '', temperature: '', result: '', remarks: '', details: '{}', source_file: '',
  };
}

router.get('/equipment/:id/recalibrate', requirePerm('equipment.edit'), (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  res.send(equipmentForm(req, { mode: 'recal', values: recalDefaults(eq), eq }));
});

router.post('/equipment/:id/recalibrate', requirePerm('equipment.edit'), (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  const { v, error } = readEquipment(req.body);
  if (error) return res.status(400).send(equipmentForm(req, { mode: 'recal', values: v, error, eq }));
  if (v.cert_no === eq.cert_no && v.cal_date === eq.cal_date) {
    return res.status(409).send(equipmentForm(req, { mode: 'recal', values: v, eq, error: `Certificate ${v.cert_no} from ${formatDate(v.cal_date)} is already the current calibration for this item, so nothing was saved.` }));
  }
  updateEquipment(eq, v, { recalibrated: true, by: req.user.name });
  audit.log(req.user, 'Recorded new calibration', `${eq.cert_no} (${eq.cal_date}) → ${v.cert_no} (${v.cal_date})${v.source_file ? ` · from ${v.source_file}` : ''}`);
  res.redirect(`/e/${eq.public_id}?saved=1`);
});

router.post('/equipment/:id/delete', requirePerm('equipment.delete'), (req, res) => {
  const eq = getEquipment(req.params.id);
  if (eq) {
    db.prepare('DELETE FROM equipment WHERE id = ?').run(eq.id);
    audit.log(req.user, 'Deleted equipment', `${eq.cert_no} · ${eq.type} · S/N ${eq.serial_no}`);
  }
  res.redirect('/equipment');
});

// ============================================================ QR labels
async function labelHtml(req, eq) {
  const svg = await QRCode.toString(scanUrl(req, eq), { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return `
    <div class="label">
      <div class="label-qr">${svg}</div>
      <div class="label-text">
        <div class="label-title">${h(site.appName())}</div>
        <div><span class="k">Cert no.</span> <span class="v">${h(eq.cert_no)}</span></div>
        <div><span class="k">Serial</span> <span class="v">${h(eq.serial_no)}</span></div>
        <div><span class="k">Type</span> ${h(eq.type)}${eq.cal_range ? ` ${h(eq.cal_range)}` : ''}</div>
        <div><span class="k">Calibrated</span> ${formatDate(eq.cal_date)}</div>
        <div class="label-due"><span class="k">Due</span> <span class="v">${formatMonth(dueDate(eq.cal_date, eq.cal_period))}</span></div>
      </div>
    </div>`;
}

const trialWarning = (req) => (site.isTrialAddress() ? `<div class="alert alert-warn no-print"><strong>Trial address.</strong> These QR codes point to ${h(site.baseUrl(req))}, which only works on this network while this PC is running the app. Set the site address under Admin → General before printing permanent labels.</div>` : '');

router.get('/equipment/:id/label', requirePerm('equipment.view'), async (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  const url = scanUrl(req, eq);
  res.send(layout({
    req,
    title: `Label ${eq.cert_no}`,
    active: 'register',
    body: `
    ${req.query.new ? alert('Equipment saved. Here is its QR label.', 'success') : ''}
    <a class="back no-print" href="/e/${eq.public_id}">${icon('back', 14)} Back to details</a>
    ${pageHead(`QR label <span class="muted mono" style="font-size:.8em;font-weight:500">${h(eq.cert_no)}</span>`, `
      <a class="btn" href="/equipment/${eq.id}/qr.png" download="QR-${h(eq.cert_no.replace(/[^\w.-]+/g, '_'))}.png">${icon('download')} QR image</a>
      <button type="button" class="btn btn-primary" data-print>${icon('printer')} Print</button>`)}
    ${trialWarning(req)}
    <div class="label-stage">${await labelHtml(req, eq)}</div>
    <p class="small muted no-print">Scanning opens <a class="mono" href="${h(url)}">${h(url)}</a>. The label is 90 × 46 mm. In the print dialog, set scale to 100%.</p>`,
  }));
});

router.get('/equipment/:id/qr.png', requirePerm('equipment.view'), async (req, res) => {
  const eq = getEquipment(req.params.id);
  if (!eq) return notFound(req, res);
  const png = await QRCode.toBuffer(scanUrl(req, eq), { width: 800, margin: 2, errorCorrectionLevel: 'M' });
  res.type('png').send(png);
});

router.get('/labels', requirePerm('equipment.view'), async (req, res) => {
  const raw = Array.isArray(req.query.ids) ? req.query.ids : String(req.query.ids || '').split(',');
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  const items = ids.map(getEquipment).filter(Boolean);
  const labels = (await Promise.all(items.map((eq) => labelHtml(req, eq)))).join('');
  res.send(layout({
    req,
    title: 'Print labels',
    active: 'register',
    wide: true,
    body: `
    <a class="back no-print" href="/equipment">${icon('back', 14)} Register</a>
    ${pageHead(`Print labels <span class="muted" style="font-size:.8em;font-weight:500">${items.length}</span>`, items.length ? `<button type="button" class="btn btn-primary" data-print>${icon('printer')} Print</button>` : '')}
    ${trialWarning(req)}
    ${items.length ? `<div class="label-stage"><div class="label-sheet">${labels}</div></div>` : '<section class="panel"><div class="empty">No equipment selected. Tick items on the register first.</div></section>'}`,
  }));
});

// ============================================================ the page a QR code opens (read-only, no login needed)
// Shows the calibration report details (result, readings, reference instruments, checks) but never notes or contact email.
router.get('/e/:publicId', (req, res) => {
  const eq = db.prepare('SELECT * FROM equipment WHERE public_id = ?').get(req.params.publicId);
  if (!eq) return notFound(req, res);
  const s = statusOf(eq);
  const due = dueDate(eq.cal_date, eq.cal_period);
  const history = db.prepare('SELECT * FROM calibration_history WHERE equipment_id = ? ORDER BY cal_date DESC, id DESC').all(eq.id);
  const u = req.user;
  const staff = u && u.can('equipment.view');
  const banner = { valid: 'Calibration in date', 'due-soon': 'Calibration due soon', overdue: 'Calibration expired. Do not use', unfit: 'Not fit for use. Do not use' }[s];
  res.set('X-Robots-Tag', 'noindex');

  const historyPanel = history.length ? `
    <section class="panel">
      <div class="panel-head"><h2>Previous calibrations</h2></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Certificate</th><th>Calibrated</th><th>Was due</th><th>Result</th><th class="hide-sm">By</th></tr></thead>
        <tbody>${history.map((r) => {
          const snap = cal.parseSnapshot(r.snapshot);
          return `<tr><td class="mono">${h(r.cert_no)}</td><td class="nowrap">${formatDate(r.cal_date)}</td><td class="nowrap">${formatMonth(dueDate(r.cal_date, r.cal_period))}</td><td>${h(cal.RESULTS[snap.result] || '—')}</td><td class="hide-sm">${h(snap.calibrated_by || '—')}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>` : '';

  const main = `
    <section class="panel">
      <div class="scan-banner b-${s}"><span class="big"></span>${banner}<span>Due ${relative(due)}</span></div>
      <div class="scan-title"><div class="eyebrow">${h(eq.cert_no)}</div><h1>${h(eq.type)}${eq.cal_range ? ` <span class="muted" style="font-weight:500">${h(eq.cal_range)}</span>` : ''}</h1></div>
      <div class="panel-body" style="padding-top:8px">${detailRows(eq)}</div>
    </section>
    ${detailTables(cal.parseDetails(eq.details))}`;

  if (!staff) {
    return res.send(layout({
      req,
      title: eq.cert_no,
      bare: true,
      body: `<div class="narrow" style="max-width:640px">${main}${historyPanel}<p class="scan-footer">${h(site.appName())} · checked ${formatDate(todayStr())}</p></div>`,
    }));
  }

  res.send(layout({
    req,
    title: eq.cert_no,
    active: 'register',
    body: `
    <a class="back" href="/equipment">${icon('back', 14)} Register</a>
    ${req.query.saved ? alert('Changes saved.', 'success') : ''}
    <div class="two-col">
      <div>${main}${historyPanel}</div>
      <aside>
        <section class="panel">
          <div class="panel-body" style="display:grid;gap:8px">
            ${u.can('equipment.edit') ? `
            <a class="btn btn-primary" href="/equipment/${eq.id}/recalibrate">Record new calibration</a>
            <a class="btn" href="/equipment/import?id=${eq.id}">${icon('upload')} New calibration from Excel</a>
            <a class="btn" href="/equipment/${eq.id}/edit">${icon('edit')} Edit details</a>` : ''}
            <a class="btn" href="/equipment/${eq.id}/label">${icon('qr')} QR label</a>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>More</h2></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>Contact</dt><dd>${eq.contact_email ? `<a href="mailto:${h(eq.contact_email)}">${h(eq.contact_email)}</a>` : '<span class="muted">—</span>'}</dd>
              ${eq.source_file ? `<dt>Imported from</dt><dd class="small">${h(eq.source_file)}</dd>` : ''}
              <dt>Added</dt><dd>${formatDateTime(eq.created_at)}</dd>
              <dt>Updated</dt><dd>${formatDateTime(eq.updated_at)}</dd>
            </dl>
            ${eq.notes ? `<div class="form-section" style="margin-top:14px"><div class="form-section-title">Notes</div><p style="white-space:pre-wrap;margin:0">${h(eq.notes)}</p></div>` : ''}
          </div>
        </section>
      </aside>
    </div>`,
  }));
});

module.exports = { router, readEquipment, insertEquipment, updateEquipment, findBySerial, equipmentForm, getEquipment };
