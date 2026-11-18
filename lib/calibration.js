// Calibration-report details: result, reference instruments, readings and checks.
const { status, todayStr } = require('./dates');

const RESULTS = {
  fit: 'Fit for use',
  limited: 'Fit for limited use',
  unfit: 'Not fit for use',
};

// Fields that belong to a single calibration (moved into history when a new calibration is recorded).
const CAL_FIELDS = ['cert_no', 'cal_date', 'cal_period', 'calibrated_by', 'procedure', 'temperature', 'result', 'remarks', 'details', 'source_file'];

const TABLES = {
  instruments: { label: 'Reference instruments', cols: [['description', 'Description'], ['make', 'Make'], ['serial', 'Serial no.'], ['cert', 'Certificate no.']] },
  readings: { label: 'Readings', cols: [['section', 'Apparatus'], ['nominal', 'Specified'], ['measured', 'Measured'], ['error', 'Error'], ['adjusted', 'Adjusted']] },
  checks: { label: 'Checks performed', cols: [['name', 'Check'], ['done', 'Done']] },
};
const MAX_ROWS = 60;
const MAX_CELL = 200;

function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);
}

// Read a size such as "30", "7.98", "8mm(7.999mm)" or "25mm(24,997mm)".
// A number in brackets is the actual value; a comma with no point is a decimal comma.
function parseMeasure(s) {
  const text = String(s ?? '').trim();
  if (!text) return null;
  const bracket = text.match(/\(([^)]*\d[^)]*)\)/);
  const m = (bracket ? bracket[1] : text).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = Number(m[0].includes(',') && !m[0].includes('.') ? m[0].replace(',', '.') : m[0]);
  return Number.isFinite(n) ? n : null;
}

// Error = specified − measured, to at most 3 decimal places ("0.019", "0.02", "10"). Blank if either isn't a number.
function computeError(nominal, measured) {
  const a = parseMeasure(nominal);
  const b = parseMeasure(measured);
  if (a === null || b === null) return null;
  const v = Number((a - b).toFixed(3));
  return String(Object.is(v, -0) ? 0 : v);
}

const ADJUSTED = ['Yes', 'No', 'N/A'];
function adjustedValue(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^(yes|y|true|1|adjusted)$/.test(s)) return 'Yes';
  if (/^(no|n|false|0)$/.test(s)) return 'No';
  return 'N/A';
}

function normaliseDetails(d) {
  const out = {};
  for (const [key, t] of Object.entries(TABLES)) {
    const rows = Array.isArray(d && d[key]) ? d[key] : [];
    out[key] = rows.slice(0, MAX_ROWS)
      .map((r) => Object.fromEntries(t.cols.map(([c]) => [c, clean(r && r[c])])))
      .filter((r) => t.cols.some(([c]) => r[c] && !(key === 'checks' && c === 'done') && !(key === 'readings' && c === 'adjusted')));
    if (key === 'checks') out[key].forEach((r) => { r.done = /^(yes|true|1|y|✓|x)$/i.test(r.done) ? 'Yes' : r.done ? 'No' : 'Yes'; });
    if (key === 'readings') {
      out[key].forEach((r) => {
        r.adjusted = adjustedValue(r.adjusted);
        const e = computeError(r.nominal, r.measured);
        if (e !== null) r.error = e; // calculated whenever both sizes are numbers; otherwise keep what was entered
      });
    }
  }
  return out;
}

function parseDetails(json) {
  try { return normaliseDetails(JSON.parse(json || '{}')); } catch { return normaliseDetails({}); }
}

// Read table rows posted from the form: inputs named e.g. instruments.description (repeated per row).
function detailsFromBody(body) {
  if (typeof body.details_json === 'string' && body.details_json) return parseDetails(body.details_json);
  const d = {};
  for (const [key, t] of Object.entries(TABLES)) {
    const colVals = t.cols.map(([c]) => [].concat(body[`${key}.${c}`] ?? []));
    const n = Math.max(0, ...colVals.map((v) => v.length));
    d[key] = Array.from({ length: n }, (_, i) => Object.fromEntries(t.cols.map(([c], j) => [c, colVals[j][i]])));
  }
  return normaliseDetails(d);
}

function resultFrom(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return '';
  if (RESULTS[s]) return s;
  if (/not\s+fit|unfit|fail|reject|out of (tol|spec)|unserviceable/.test(s)) return 'unfit';
  if (/limit|restrict|conditional/.test(s)) return 'limited';
  if (/fit|pass|ok|serviceable|accept|within/.test(s)) return 'fit';
  return '';
}

// Overall status: a "not fit for use" result overrides the dates.
const STATUS_LABELS = { valid: 'Valid', 'due-soon': 'Due soon', overdue: 'Overdue', unfit: 'Not fit for use' };
function equipmentStatus(eq, today = todayStr(), soonDays = 30) {
  if (eq.result === 'unfit') return 'unfit';
  return status(eq.cal_date, today, soonDays, eq.cal_period);
}

// The calibration-specific part of a record, for the history table.
function snapshotOf(eq) {
  return JSON.stringify(Object.fromEntries(CAL_FIELDS.map((k) => [k, eq[k]])));
}
function parseSnapshot(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

module.exports = { parseMeasure, computeError, ADJUSTED, adjustedValue, RESULTS, TABLES, CAL_FIELDS, normaliseDetails, parseDetails, detailsFromBody, resultFrom, equipmentStatus, STATUS_LABELS, snapshotOf, parseSnapshot, clean };
