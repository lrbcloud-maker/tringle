// Reads calibration reports from Excel (.xlsx) files and turns them into register fields.
// Values are found by their label text ("SERIAL NUMBER:", "CALIBRATED BY:" ...), not by fixed cell
// addresses, so slightly different layouts still work. Anything not found is left blank for the user.
const ExcelJS = require('exceljs');
const { isValidDate } = require('./dates');
const cal = require('./calibration');

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

// ---------- cell values ----------
function isoFromDate(d) {
  // Excel dates arrive as UTC midnight; read them with UTC getters so the day can't shift.
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function rawValue(cell) {
  let v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('result' in v || 'formula' in v || 'sharedFormula' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if ('error' in v) v = null;
    else v = null;
  }
  return v;
}

function textOf(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isoFromDate(v);
  if (typeof v === 'number') return String(Number(v.toPrecision(10)));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\s+/g, ' ').trim();
}

// A grid of "master" cells only (merged areas count once), each with text and raw value.
function readGrid(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;
      const raw = rawValue(cell);
      const text = textOf(raw);
      if (text !== '' || typeof raw === 'boolean') cells.push({ r, c, raw, text });
    });
    if (cells.length) rows.push({ r, cells });
  });
  return rows;
}

const norm = (s) => s.toLowerCase().replace(/[.:#]+/g, ' ').replace(/\s+/g, ' ').trim();

function sentence(s) {
  if (!s) return s;
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  const lower = s.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------- dates ----------
function parseDate(raw) {
  if (raw instanceof Date) return isoFromDate(raw);
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) { // Excel serial day number
    return isoFromDate(new Date(Date.UTC(1899, 11, 30) + Math.round(raw) * 864e5));
  }
  const s = textOf(raw);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return check(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/); // day first (UK)
  if (m) return check(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([a-z]{3})[a-z]*[\s\-,]+(\d{4})$/i);
  if (m && MONTH_NAMES.includes(m[2].toLowerCase())) return check(+m[3], MONTH_NAMES.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return '';
  function check(y, mo, d) { const iso = `${y}-${pad(mo)}-${pad(d)}`; return isValidDate(iso) ? iso : ''; }
}

function parsePeriod(text) {
  const s = String(text || '').toLowerCase();
  const n = parseFloat(s);
  if (!n) return null;
  if (/year|yr|annual/.test(s)) return Math.round(n * 12);
  if (/week/.test(s)) return Math.max(1, Math.round(n / 4.345));
  return Math.round(n);
}

// ---------- one worksheet ----------
const LABELS = {
  cert_no: /^(report|certificate|cert)( no| number| ref| reference)?$/,
  type: /^(calibration of|instrument|equipment|equipment type|type of equipment|item|description of item)$/,
  manufacturer: /^(manufacturer|make|maker|brand)$/,
  model: /^(model|model no|model number)$/,
  serial_no: /^(serial|serial no|serial number|s\/n)$/,
  calibrated_by: /^(calibrated by|technician|inspected by|tested by)$/,
  cal_date: /^(date of calibration|calibration date|date calibrated|date of test|cal date)$/,
  cal_range: /^(range|capacity|measuring range)$/,
  procedure: /^(works? instructions?|procedure|method|calibration procedure)$/,
  owner: /^(owner|customer|client|issued to)$/,
  department: /^(department|dept|location)$/,
  cal_period: /^(calibration )?(interval|period|frequency)$/,
  remarks: /^remarks?$/,
  final: /^final remarks?$/,
};

function parseSheet(ws) {
  const rows = readGrid(ws);
  const all = rows.flatMap((row) => row.cells);
  const out = { fields: {}, details: { instruments: [], readings: [], checks: [] }, found: [] };
  const cellAt = (r, c) => all.find((x) => x.r === r && x.c === c);
  const rightOf = (cell) => rows.find((row) => row.r === cell.r).cells.filter((x) => x.c > cell.c && x.text && x.text !== cell.text);
  const below = (cell, max = 3) => {
    const res = [];
    for (let r = cell.r + 1; r <= cell.r + max; r++) {
      const x = all.find((y) => y.r === r && y.c === cell.c);
      if (!x || !x.text) break;
      res.push(x);
    }
    return res;
  };
  const labelCell = (re) => all.find((x) => typeof x.raw !== 'boolean' && x.text.length < 60 && re.test(norm(x.text)));

  // Simple "LABEL: value" pairs, value to the right (or below for headings like WORKS INSTRUCTIONS).
  for (const [key, re] of Object.entries(LABELS)) {
    const cell = labelCell(re);
    if (!cell) continue;
    const right = rightOf(cell);
    let value = '';
    let raw = null;
    if (key === 'cal_range') value = right.slice(0, 2).map((x) => x.text).join(' ');
    else if (key === 'procedure') value = (right.length ? right.slice(0, 1) : below(cell, 2)).map((x) => x.text).join(' ').replace(/\s*;\s*/g, '; ');
    else if (key === 'remarks') value = (right.length ? right.slice(0, 1) : below(cell, 3)).map((x) => x.text).join(' ');
    else if (right.length) { value = right[0].text; raw = right[0].raw; }
    if (key === 'cal_date') {
      const original = raw ?? value;
      value = parseDate(original);
      // A text date like 02/11/2026 could be read either way; it's read day-first, so flag it for checking.
      const m = typeof original === 'string' && original.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}$/);
      if (value && m && +m[1] <= 12 && +m[2] <= 12 && m[1] !== m[2]) out.dateNote = original;
    }
    if (value) { out.fields[key] = value; out.found.push(key); }
  }

  // "FINAL REMARKS: Fit For Use" in a single cell
  const finalCell = all.find((x) => /^final remarks?\s*:\s*\S/i.test(x.text));
  if (finalCell) out.fields.final = finalCell.text.replace(/^final remarks?\s*:\s*/i, '');
  if (out.fields.final) {
    out.fields.result = cal.resultFrom(out.fields.final);
    if (out.fields.result) out.found.push('result');
  }
  if (out.fields.model && out.fields.type && !out.fields.type.includes(out.fields.model)) out.fields.type = `${out.fields.type} ${out.fields.model}`;

  // Temperature anywhere, e.g. "RESULTS AT TIME OF CALIBRATION (Temperature: 19 - 21 ºC )"
  const tempCell = all.find((x) => /temperature\s*:?\s*[-\d]/i.test(x.text));
  if (tempCell) {
    const m = tempCell.text.match(/temperature\s*:?\s*([^)]*?\d[^)]*?)\s*\)?$/i);
    if (m) { out.fields.temperature = m[1].replace(/\s*-\s*/g, '–').replace(/\s*º\s*C/i, ' °C').trim(); out.found.push('temperature'); }
  } else {
    const t = labelCell(/^(temperature|ambient temperature|temp)$/);
    if (t && rightOf(t).length) { out.fields.temperature = rightOf(t)[0].text; out.found.push('temperature'); }
  }

  if (out.fields.cal_period) out.fields.cal_period = parsePeriod(out.fields.cal_period);

  // Reference instruments table: header row with DESCRIPTION / MAKE / SERIAL / CERTIFICATE
  const instHead = rows.find((row) => {
    const t = row.cells.map((x) => norm(x.text));
    return t.some((s) => /^description$/.test(s)) && t.some((s) => /^(make|manufacturer)$/.test(s)) && t.some((s) => /serial/.test(s));
  });
  if (instHead) {
    const colOf = (re) => (instHead.cells.find((x) => re.test(norm(x.text))) || {}).c;
    const cols = { description: colOf(/^description$/), make: colOf(/^(make|manufacturer)$/), serial: colOf(/serial/), cert: colOf(/cert/) };
    for (let r = instHead.r + 1; r < instHead.r + 30; r++) {
      const get = (c) => (c ? textOf((cellAt(r, c) || {}).raw) : '');
      const row = { description: sentence(get(cols.description)), make: get(cols.make), serial: get(cols.serial), cert: get(cols.cert) };
      if (!row.description && !row.serial) break;
      out.details.instruments.push(row);
    }
    if (out.details.instruments.length) out.found.push('instruments');
  }

  // Readings table: header row with SPECIFIED/NOMINAL and MEASURED
  const readHead = rows.find((row) => {
    const t = row.cells.map((x) => norm(x.text));
    return t.some((s) => /specified|nominal|reference value|standard/.test(s)) && t.some((s) => /measured|reading|actual/.test(s));
  });
  if (readHead) {
    const colOf = (re) => (readHead.cells.find((x) => re.test(norm(x.text))) || {}).c;
    const cols = { nominal: colOf(/specified|nominal|reference value|standard/), measured: colOf(/measured|reading|actual/), error: colOf(/error|deviation/), adjusted: colOf(/adjust/) };
    let section = '';
    let blanks = 0;
    for (const row of rows.filter((x) => x.r > readHead.r)) {
      const txt = row.cells.map((x) => x.text).join(' ');
      if (/functions tested|final remarks|end of report|^remarks/i.test(txt)) break;
      const get = (c) => (c ? (row.cells.find((x) => x.c === c) || {}) : {});
      const nominal = get(cols.nominal), measured = get(cols.measured);
      const textCells = row.cells.filter((x) => x.text && typeof x.raw !== 'boolean');
      if (!measured.text && textCells.length === 1 && !/^-?[\d.,]+$/.test(textCells[0].text)) {
        section = sentence(textCells[0].text); // a heading row such as INTERNAL MEASUREMENTS
        continue;
      }
      if (!nominal.text && !measured.text) {
        if (++blanks > 1) break;
        continue;
      }
      blanks = 0;
      if (!nominal.text) continue; // junk row without a specified size
      let error = get(cols.error).text || '';
      if (!error && typeof nominal.raw === 'number' && typeof measured.raw === 'number') error = textOf(nominal.raw - measured.raw);
      if (error && /^-?\d+\.\d{5,}$/.test(error)) error = String(Number(Number(error).toFixed(4)));
      out.details.readings.push({ section, nominal: nominal.text, measured: measured.text || '', error, adjusted: get(cols.adjusted).text || '' });
    }
    if (out.details.readings.length) out.found.push('readings');
  }

  // Functions tested: names listed under the heading, with a tick box (TRUE/FALSE) on the same row
  const fnHead = labelCell(/^(functions tested|checks|checks performed|tests performed)$/);
  if (fnHead) {
    for (let r = fnHead.r + 1; r < fnHead.r + 20; r++) {
      const name = cellAt(r, fnHead.c);
      if (!name || !name.text) break;
      const tick = rows.find((row) => row.r === r)?.cells.find((x) => typeof x.raw === 'boolean');
      out.details.checks.push({ name: sentence(name.text), done: tick ? (tick.raw ? 'Yes' : 'No') : 'Yes' });
    }
    if (out.details.checks.length) out.found.push('checks');
  }

  if (out.fields.remarks) out.fields.remarks = sentence(out.fields.remarks);
  if (out.fields.type) out.fields.type = sentence(out.fields.type);
  return out;
}

// What makes a sheet look like a calibration report (needs at least two of these).
const KEY_FIELDS = ['cert_no', 'serial_no', 'cal_date', 'type'];

async function parseWorkbook(buffer, filename = '') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const results = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const parsed = parseSheet(ws);
    if (KEY_FIELDS.filter((k) => parsed.fields[k]).length < 2) return;
    parsed.file = filename;
    parsed.sheet = ws.name;
    parsed.details = cal.normaliseDetails(parsed.details);
    results.push(parsed);
  });
  return results;
}

module.exports = { parseWorkbook, parseDate, parsePeriod };
