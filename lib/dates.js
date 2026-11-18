// All dates are plain "YYYY-MM-DD" strings. We never parse them with local-time
// Date objects, which can shift a date by a day depending on the timezone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const parts = (s) => s.split('-').map(Number);

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const DEFAULT_PERIOD = 12;
const MAX_PERIOD = 120;

function periodOf(months) {
  const n = Number(months);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PERIOD ? n : DEFAULT_PERIOD;
}

// Calibration is due at the END of the month that is <period> months after the calibration month.
// e.g. calibrated 20 Dec 2025 with a 12-month period -> due Dec 2026 (valid until 31 Dec 2026).
// Returns that last day as YYYY-MM-DD so it can be compared with other dates.
function dueDate(calDate, months = DEFAULT_PERIOD) {
  const [y, m] = parts(calDate);
  const idx = (m - 1) + periodOf(months); // 0-based month index from year y
  const dy = y + Math.floor(idx / 12);
  const dm = (idx % 12) + 1;
  const lastDay = new Date(Date.UTC(dy, dm, 0)).getUTCDate();
  return `${dy}-${pad(dm)}-${pad(lastDay)}`;
}

// "Dec 2026"
function formatMonth(s) {
  const [y, m] = parts(s);
  return `${MONTHS[m - 1]} ${y}`;
}

// "12 months (1 year)", "18 months", "24 months (2 years)"
function formatPeriod(months) {
  const n = periodOf(months);
  if (n % 12 === 0) return `${n} months (${n / 12} year${n === 12 ? '' : 's'})`;
  return `${n} month${n === 1 ? '' : 's'}`;
}

function todayStr() {
  if (process.env.FAKE_TODAY && isValidDate(process.env.FAKE_TODAY)) return process.env.FAKE_TODAY; // tests only
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function addDays(s, days) {
  const [y, m, d] = parts(s);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function daysBetween(from, to) {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
}

function status(calDate, today = todayStr(), soonDays = 30, months = DEFAULT_PERIOD) {
  const due = dueDate(calDate, months);
  if (due < today) return 'overdue';
  if (due <= addDays(today, soonDays)) return 'due-soon';
  return 'valid';
}

// Whole calendar months from a to b (a <= b), rounded down. 18 Nov -> 17 Dec = 0, 18 Nov -> 18 Dec = 1.
function wholeMonths(a, b) {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  let n = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) n -= 1;
  return Math.max(0, n);
}

// "in 60 months", "in 1 month", "in 12 days", "today", "3 months ago".
// Whole months (rounded down) until it's under a month away, then days.
function relative(date, today = todayStr()) {
  const n = daysBetween(today, date);
  if (n === 0) return 'today';
  const future = n > 0;
  const months = future ? wholeMonths(today, date) : wholeMonths(date, today);
  if (months >= 1) return future ? `in ${months} month${months === 1 ? '' : 's'}` : `${months} month${months === 1 ? '' : 's'} ago`;
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return future ? `in ${n} days` : `${-n} days ago`;
}

const STATUS_LABELS = { valid: 'Valid', 'due-soon': 'Due soon', overdue: 'Overdue' };

function formatDate(s) {
  const [y, m, d] = parts(s);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  isValidDate, dueDate, todayStr, addDays, daysBetween, status, relative, STATUS_LABELS,
  formatDate, formatDateTime, formatMonth, formatPeriod, periodOf, DEFAULT_PERIOD, MAX_PERIOD,
};
