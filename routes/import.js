// Import calibration reports from Excel: one file fills in the form, several files go to a review table.
const express = require('express');
const multer = require('multer');
const { tx, db } = require('../lib/db');
const audit = require('../lib/audit');
const cal = require('../lib/calibration');
const { parseWorkbook } = require('../lib/importer');
const { formatDate, DEFAULT_PERIOD, MAX_PERIOD } = require('../lib/dates');
const { h, icon, combo, layout, alert, pageHead } = require('../lib/views');
const lists = require('../lib/lists');
const { requirePerm, notFound } = require('../lib/http');
const eqr = require('./equipment');

const router = express.Router();
const MAX_FILES = 50;
const MAX_MB = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES, fields: 10, parts: MAX_FILES + 10 },
});

const FIELD_NAMES = {
  cert_no: 'certificate number', type: 'type of equipment', manufacturer: 'manufacturer', serial_no: 'serial number', cal_range: 'range',
  calibrated_by: 'calibrated by', cal_date: 'date of calibration', procedure: 'procedure', temperature: 'temperature', result: 'result',
  remarks: 'remarks', owner: 'owner', department: 'department', cal_period: 'calibration period', instruments: 'reference instruments',
  readings: 'readings', checks: 'checks performed',
};

// ---------- upload page ----------
function uploadPage(req, { error = '', target = null } = {}) {
  return layout({
    req,
    title: 'Import from Excel',
    active: 'register',
    body: `
    <a class="back" href="${target ? `/e/${target.public_id}` : '/equipment'}">${icon('back', 14)} ${target ? 'Back to details' : 'Register'}</a>
    ${pageHead('Import calibration reports', '', target
      ? `New calibration for <span class="mono">${h(target.serial_no)}</span> (${h(target.type)}, currently ${h(target.cert_no)}).`
      : 'Upload one or more Excel calibration reports. Nothing is saved until you check the details.')}
    ${alert(error)}
    <form method="post" action="/equipment/import" enctype="multipart/form-data" class="panel">
      <div class="panel-body form">
        ${target ? `<input type="hidden" name="target" value="${target.id}">` : ''}
        <label class="dropzone" data-dropzone>
          ${icon('upload', 28)}
          <strong>Choose Excel files</strong>
          <span class="muted small">or drag them here · .xlsx, up to ${MAX_FILES} files, ${MAX_MB} MB each</span>
          <input type="file" name="files" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${target ? '' : 'multiple'} required>
          <span class="dropzone-files" data-dropzone-files></span>
        </label>
        <div><button class="btn btn-primary">${icon('upload')} Read files</button></div>
      </div>
    </form>
    <section class="panel">
      <div class="panel-head"><h2>What gets read</h2></div>
      <div class="panel-body">
        <p class="muted">The app looks for these labels anywhere on each sheet and takes the value next to them:</p>
        <dl class="kv">
          <dt>Report No.</dt><dd>Certificate number</dd>
          <dt>Calibration of</dt><dd>Type of equipment (and Range)</dd>
          <dt>Manufacturer · Serial number</dt><dd>Manufacturer · Serial number</dd>
          <dt>Calibrated by · Date of calibration</dt><dd>Calibrated by · Date (dd/mm/yyyy)</dd>
          <dt>Works instructions · Temperature</dt><dd>Procedure · Temperature</dd>
          <dt>Instruments used · Results · Functions tested</dt><dd>Reference instruments · Readings · Checks</dd>
          <dt>Final remarks</dt><dd>Result (e.g. "Fit for use")</dd>
        </dl>
        <p class="muted small" style="margin:12px 0 0">Owner, department and calibration period usually aren't on the report. You'll fill those in before saving. A workbook with several report sheets gives one item per visible sheet. Old .xls files need saving as .xlsx first.</p>
      </div>
    </section>`,
  });
}

router.get('/equipment/import', requirePerm('equipment.edit'), (req, res) => {
  const target = req.query.id ? eqr.getEquipment(req.query.id) : null;
  if (req.query.id && !target) return notFound(req, res);
  res.send(uploadPage(req, { target }));
});

// The parts of an existing item that a new report shouldn't wipe (the report fills in the calibration).
function baseFrom(eq) {
  if (!eq) return {};
  const keep = ['type', 'manufacturer', 'serial_no', 'cal_range', 'procedure', 'owner', 'department', 'cal_period', 'contact_email', 'notes'];
  return Object.fromEntries(keep.map((k) => [k, eq[k]]));
}

// Turn a parsed sheet into form values.
function toValues(p, base = {}) {
  const f = p.fields;
  return {
    ...base,
    cert_no: f.cert_no || '',
    type: f.type || base.type || '',
    manufacturer: f.manufacturer || base.manufacturer || '',
    serial_no: f.serial_no || base.serial_no || '',
    cal_range: f.cal_range || base.cal_range || '',
    calibrated_by: f.calibrated_by || '',
    cal_date: f.cal_date || '',
    procedure: f.procedure || base.procedure || '',
    temperature: f.temperature || '',
    result: f.result || '',
    remarks: f.remarks || '',
    owner: f.owner || base.owner || '',
    department: f.department || base.department || '',
    cal_period: f.cal_period && f.cal_period <= MAX_PERIOD ? f.cal_period : base.cal_period || DEFAULT_PERIOD,
    details: p.details,
    source_file: p.sheetCount > 1 ? `${p.file} › ${p.sheet}` : p.file,
  };
}

function summary(p, values) {
  const found = p.found.filter((k) => FIELD_NAMES[k]).map((k) => FIELD_NAMES[k]);
  const missing = ['owner', 'department'].filter((k) => !values[k]).map((k) => FIELD_NAMES[k]);
  let s = `Filled in from ${values.source_file}: ${found.join(', ') || 'nothing recognised'}.`;
  if (missing.length) s += ` Not in the file, please fill in: ${missing.join(', ')}.`;
  if (!p.fields.cal_period) s += ` Calibration period isn't in the file, so it's set to ${values.cal_period} months.`;
  if (p.dateNote) s += ` Check the date: "${p.dateNote}" was read as ${formatDate(values.cal_date)} (day/month/year).`;
  return s;
}

router.post('/equipment/import', requirePerm('equipment.edit'), (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than ${MAX_MB} MB.` : err.code === 'LIMIT_FILE_COUNT' ? `You can import up to ${MAX_FILES} files at once.` : 'The upload failed. Please try again.';
    res.status(400).send(uploadPage(req, { error: msg }));
  });
}, async (req, res) => {
  const target = req.body.target ? eqr.getEquipment(req.body.target) : null;
  const files = req.files || [];
  if (!files.length) return res.status(400).send(uploadPage(req, { error: 'Choose at least one Excel file.', target }));

  const problems = [];
  const parsed = [];
  for (const file of files) {
    const name = String(file.originalname || 'file.xlsx').replace(/[\r\n"]/g, '').slice(0, 150);
    if (!/\.(xlsx|xlsm)$/i.test(name)) { problems.push(`${name}: not an .xlsx file`); continue; }
    try {
      const sheets = await parseWorkbook(file.buffer, name);
      if (!sheets.length) problems.push(`${name}: no calibration report found`);
      sheets.forEach((s) => { s.sheetCount = sheets.length; parsed.push(s); });
    } catch {
      problems.push(`${name}: couldn't be read (is it a valid .xlsx file?)`);
    }
  }
  if (!parsed.length) return res.status(400).send(uploadPage(req, { error: `Nothing to import. ${problems.join('; ')}.`, target }));

  // One report: fill in the normal form so it can be checked and completed.
  if (parsed.length === 1 || target) {
    const p = parsed[0];
    const match = target || eqr.findBySerial(p.fields.serial_no);
    const values = toValues(p, baseFrom(match));
    let notice = summary(p, values);
    if (parsed.length > 1) notice += ` Only the first report (${values.source_file}) was used.`;
    if (problems.length) notice += ` Skipped: ${problems.join('; ')}.`;
    if (match) {
      const plan = planFor(values, match);
      if (plan.kind === 'dup') {
        return res.send(uploadPage(req, { target, error: `${values.source_file} is already recorded for serial ${match.serial_no}: ${plan.text}. Nothing was changed.` }));
      }
      if (plan.kind === 'history') { // an older report: offer to add it to the history, never make it current
        return res.send(reviewPage(req, [{ values, dateNote: p.dateNote || '' }], { problems }));
      }
      if (target && p.fields.serial_no && p.fields.serial_no.toLowerCase() !== target.serial_no.toLowerCase()) {
        notice = `Check the file: its serial number (${p.fields.serial_no}) doesn't match this item (${target.serial_no}). Saving will change the item's serial number. ${notice}`;
      } else if (!target) {
        notice = `Serial ${match.serial_no} is already in the register (${match.cert_no}). Saving records this as a new calibration for it and moves ${match.cert_no} into its history. ${notice}`;
      }
      return res.send(eqr.equipmentForm(req, { mode: 'recal', values, eq: match, notice }));
    }
    return res.send(eqr.equipmentForm(req, { mode: 'new', values, notice }));
  }

  // Several reports: review table. Rows for serials already in the register start from that item's details.
  const items = parsed.map((p) => ({ values: toValues(p, baseFrom(eqr.findBySerial(p.fields.serial_no))), dateNote: p.dateNote || '' }));
  res.send(reviewPage(req, items, { problems }));
});

// ---------- review & confirm ----------
// What importing this report would do: add a new item, add a new calibration, add to history, or nothing.
function planFor(v, match = eqr.findBySerial(v.serial_no)) {
  if (!match) return { kind: 'new', text: 'Add as new item' };
  if (match.cert_no === v.cert_no && match.cal_date === v.cal_date) return { kind: 'dup', text: `Already recorded (${match.cert_no})`, match };
  const already = db.prepare('SELECT 1 FROM calibration_history WHERE equipment_id = ? AND cert_no = ? AND cal_date = ?').get(match.id, v.cert_no, v.cal_date);
  if (already) return { kind: 'dup', text: `Already in ${match.cert_no}'s history`, match };
  if (v.cal_date && v.cal_date < match.cal_date) return { kind: 'history', text: `Older than ${match.cert_no}: add to its history`, match };
  return { kind: 'recal', text: `New calibration for ${match.cert_no}`, match };
}

function reviewPage(req, items, { problems = [], errors = {}, defaults = {} } = {}) {
  const ownerList = lists.values('owner');
  const deptList = lists.values('department');
  const rows = items.map((it, i) => {
    const v = it.values;
    const plan = planFor(v);
    const err = errors[i];
    const include = it.include ?? plan.kind !== 'dup';
    const data = { ...v };
    for (const k of ['cal_date', 'owner', 'department', 'cal_period']) delete data[k];
    return `
      <tr class="${err ? 'row-error' : ''}">
        <td class="sel"><input type="checkbox" name="inc_${i}" value="1" ${include ? 'checked' : ''} aria-label="Import ${h(v.cert_no)}">
          <input type="hidden" name="data_${i}" value="${h(JSON.stringify(data))}"><input type="hidden" name="note_${i}" value="${h(it.dateNote)}"></td>
        <td><span class="mono">${h(v.cert_no) || '<span class="muted">—</span>'}</span><span class="sub">${h(v.source_file)}</span>${err ? `<span class="sub err">${h(err)}</span>` : ''}</td>
        <td>${h(v.type)}<span class="sub mono">S/N ${h(v.serial_no) || '—'}</span>${v.result ? `<span class="sub">${h(cal.RESULTS[v.result])}</span>` : ''}</td>
        <td><input type="date" name="cal_date_${i}" value="${h(v.cal_date)}" aria-label="Date of calibration">${it.dateNote ? `<span class="sub">read from "${h(it.dateNote)}"</span>` : ''}</td>
        <td style="min-width:170px">${combo({ name: `owner_${i}`, value: v.owner, options: ownerList, label: 'Owner', placeholder: defaults.owner || 'Owner', newLabel: 'Add new owner' })}</td>
        <td style="min-width:170px">${combo({ name: `department_${i}`, value: v.department, options: deptList, label: 'Department', placeholder: defaults.department || 'Department', newLabel: 'Add new department' })}</td>
        <td><input type="number" name="cal_period_${i}" value="${h(v.cal_period)}" min="1" max="${MAX_PERIOD}" style="width:80px" aria-label="Period in months"></td>
        <td class="small"><span class="tag ${plan.kind === 'dup' ? '' : plan.kind === 'new' ? 'tag-accent' : 'tag-warn'}">${h(plan.text)}</span></td>
      </tr>`;
  }).join('');
  return layout({
    req,
    title: 'Review import',
    active: 'register',
    wide: true,
    body: `
    <a class="back" href="/equipment/import">${icon('back', 14)} Choose different files</a>
    ${pageHead(`Review ${items.length} report${items.length === 1 ? "" : "s"}`, '', 'Check each row, fill in anything missing, then import. Rows that match an existing serial number become a new calibration for that item.')}
    ${problems.length ? alert(`Skipped: ${problems.join('; ')}.`, 'warn') : ''}
    ${Object.keys(errors).length ? alert('Some rows need fixing. They\'re marked below.') : ''}
    <form method="post" action="/equipment/import/confirm" class="panel">
      <input type="hidden" name="count" value="${items.length}">
      <div class="panel-body">
        <div class="form-section-title">For rows left blank</div>
        <div class="grid-3">
          <div class="field"><label for="default_owner" class="computed-label">Owner</label>${combo({ name: 'default_owner', value: defaults.owner, options: ownerList, label: 'Owner', newLabel: 'Add new owner' })}</div>
          <div class="field"><label for="default_department" class="computed-label">Department</label>${combo({ name: 'default_department', value: defaults.department, options: deptList, label: 'Department', newLabel: 'Add new department' })}</div>
        </div>
      </div>
      <div class="table-wrap"><table class="table table-edit">
        <thead><tr><th class="sel"></th><th>Certificate</th><th>Equipment</th><th>Calibrated</th><th>Owner</th><th>Department</th><th>Months</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="panel-foot"><button class="btn btn-primary">${icon('upload')} Import ticked rows</button><a class="btn btn-quiet" href="/equipment">Cancel</a></div>
    </form>`,
  });
}

router.post('/equipment/import/confirm', requirePerm('equipment.edit'), (req, res) => {
  const count = Math.min(Number(req.body.count) || 0, MAX_FILES * 10);
  const defaults = { owner: String(req.body.default_owner || '').trim(), department: String(req.body.default_department || '').trim() };
  const items = [];
  for (let i = 0; i < count; i++) {
    let data = {};
    try { data = JSON.parse(req.body[`data_${i}`] || '{}') || {}; } catch { data = {}; }
    const values = {
      ...data,
      cal_date: String(req.body[`cal_date_${i}`] || ''),
      owner: String(req.body[`owner_${i}`] || '').trim(),
      department: String(req.body[`department_${i}`] || '').trim(),
      cal_period: String(req.body[`cal_period_${i}`] || DEFAULT_PERIOD),
    };
    items.push({ values, include: Boolean(req.body[`inc_${i}`]), dateNote: String(req.body[`note_${i}`] || '') });
  }

  // Validate every ticked row through the same rules as the normal form.
  const errors = {};
  const ready = [];
  items.forEach((it, i) => {
    if (!it.include) return;
    const body = { ...it.values, owner: it.values.owner || defaults.owner, department: it.values.department || defaults.department, details_json: JSON.stringify(it.values.details || {}) };
    const { v, error } = eqr.readEquipment(body);
    if (error) errors[i] = error;
    else ready.push({ i, v });
  });
  if (Object.keys(errors).length) return res.status(400).send(reviewPage(req, items, { errors, defaults }));
  if (!ready.length) return res.redirect('/equipment');

  // Oldest first, so a newer report for the same serial lands on top of an older one.
  ready.sort((a, b) => a.v.cal_date.localeCompare(b.v.cal_date));
  const done = { new: 0, recal: 0, history: 0, dup: 0 };
  tx(() => {
    for (const { v } of ready) {
      const plan = planFor(v);
      if (plan.kind === 'dup') { done.dup++; continue; }
      if (plan.kind === 'new') { eqr.insertEquipment(v); done.new++; continue; }
      if (plan.kind === 'history') {
        db.prepare('INSERT INTO calibration_history (equipment_id, cert_no, cal_date, cal_period, recorded_at, recorded_by, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(plan.match.id, v.cert_no, v.cal_date, v.cal_period, Date.now(), req.user.name, cal.snapshotOf(v));
        done.history++;
        continue;
      }
      eqr.updateEquipment(plan.match, { ...plan.match, ...v, contact_email: plan.match.contact_email, notes: plan.match.notes }, { recalibrated: true, by: req.user.name });
      done.recal++;
    }
  });
  const parts = [];
  if (done.new) parts.push(`${done.new} new item${done.new === 1 ? '' : 's'}`);
  if (done.recal) parts.push(`${done.recal} new calibration${done.recal === 1 ? '' : 's'}`);
  if (done.history) parts.push(`${done.history} older report${done.history === 1 ? '' : 's'} added to history`);
  if (done.dup) parts.push(`${done.dup} already recorded`);
  const msg = `Imported from Excel: ${parts.join(', ') || 'nothing'}.`;
  audit.log(req.user, 'Imported from Excel', msg);
  res.redirect(`/equipment?imported=${encodeURIComponent(msg)}`);
});

module.exports = { router };
