const { dueDate, formatDate, formatMonth, formatPeriod, relative, todayStr } = require('./dates');
const cal = require('./calibration');
const site = require('./site');
const settings = require('./settings');

// Escape everything that goes into HTML. Every value from the database or a form passes through this.
function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Small stroke icons (24px grid).
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  printer: '<path d="M7 9V3h10v6M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3"/><path d="M7 14h10v7H7z"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  mail: '<path d="M3 6h18v12H3z"/><path d="M3 7l9 6 9-6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const icon = (name, size = 16) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// The brand mark: a simple gauge.
const MARK = '<svg class="mark" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13.5l4-5"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/></svg>';

// Runs before first paint so the page never flashes the wrong theme.
const THEME_BOOT = `<script>(function(){var t;try{t=localStorage.getItem('theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})()</script>`;

function layout({ req, title, body, active = '', wide = false, bare = false }) {
  const user = req && req.user;
  const name = site.appName();
  const navItem = (key, href, label) => `<a href="${href}" class="${active === key ? 'active' : ''}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  const nav = user && !bare ? `
      <nav class="nav" aria-label="Main">
        ${user.can('equipment.view') ? navItem('register', '/equipment', 'Register') : ''}
        ${user.can('users.manage') ? navItem('admin', '/admin/users', 'Admin') : ''}
        ${!user.can('users.manage') && user.can('audit.view') ? navItem('activity', '/admin/activity', 'Activity') : ''}
      </nav>` : '';
  const right = `
      <div class="top-right">
        <button type="button" class="icon-btn" data-theme-toggle aria-label="Switch light or dark theme" title="Switch theme">
          <span class="when-light">${icon('moon', 18)}</span><span class="when-dark">${icon('sun', 18)}</span>
        </button>
        ${user && !bare ? `
        <a class="user-link ${active === 'account' ? 'active' : ''}" href="/account" title="Your account">${h(user.name)}</a>
        <form method="post" action="/logout" class="inline"><button class="text-btn">Log out</button></form>` : ''}
      </div>`;

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${h(title)} — ${h(name)}</title>
${THEME_BOOT}
<link rel="stylesheet" href="/style.css?v=8">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1d4f73" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13.5l4-5"/></svg>')}">
<script src="/app.js?v=8" defer></script>
</head>
<body>
<header class="topbar">
  <div class="bar ${wide ? 'wide' : ''}">
    <a class="brand" href="${user ? '/equipment' : '#'}">${MARK}<span class="${nav ? 'hide-sm' : ''}">${h(name)}</span></a>
    ${nav}
    ${right}
  </div>
</header>
<main class="container ${wide ? 'wide' : ''}">
${body}
</main>
</body>
</html>`;
}

const soonDays = () => settings.num('due_soon_days') || 30;

// eq = an equipment row. A "Not fit for use" result overrides the dates.
const statusOf = (eq, today = todayStr()) => cal.equipmentStatus(eq, today, soonDays());
function statusTag(eq, today = todayStr()) {
  const s = statusOf(eq, today);
  return `<span class="status status-${s}"><i></i>${cal.STATUS_LABELS[s]}</span>`;
}

// A text box with a dropdown of existing values. You can pick one, or type a new value to add it.
function combo({ name, value = '', options = [], id = name, required = false, mono = false, label = '', placeholder = '', newLabel = 'Add' }) {
  return `<div class="combo" data-combo data-new-label="${h(newLabel)}">
    <input type="text" id="${h(id)}" name="${h(name)}" value="${h(value)}" ${required ? 'required' : ''} maxlength="200" autocomplete="off"
      role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${h(id)}-list"${label ? ` aria-label="${h(label)}"` : ''}${placeholder ? ` placeholder="${h(placeholder)}"` : ''}${mono ? ' class="mono"' : ''}>
    <button type="button" class="combo-toggle" tabindex="-1" aria-label="Show all${label ? ` ${h(label.toLowerCase())}` : ''} options">${icon('chevron', 16)}</button>
    <ul class="combo-list" id="${h(id)}-list" role="listbox" hidden></ul>
    <script type="application/json" data-combo-options>${JSON.stringify(options).replace(/</g, '\\u003c')}</script>
  </div>`;
}

const alert = (msg, kind = 'error') => (msg ? `<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${h(msg)}</div>` : '');

function pageHead(title, actions = '', sub = '') {
  return `<div class="page-head">
    <div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}
  </div>`;
}

const FIELDS = [
  { key: 'cert_no', label: 'Certificate number', mono: true },
  { key: 'owner', label: 'Owner' },
  { key: 'department', label: 'Department' },
  { key: 'type', label: 'Type of equipment' },
  { key: 'serial_no', label: 'Serial number', mono: true },
];

// Optional fields shown only when filled in.
const EXTRA_FIELDS = [
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'cal_range', label: 'Range' },
];
const CAL_DETAIL_FIELDS = [
  { key: 'calibrated_by', label: 'Calibrated by' },
  { key: 'procedure', label: 'Procedure / work instruction', mono: true },
  { key: 'temperature', label: 'Temperature' },
];

function detailRows(eq) {
  const due = dueDate(eq.cal_date, eq.cal_period);
  const opt = (list) => list.filter((f) => eq[f.key]).map((f) => `<div><dt>${f.label}</dt><dd${f.mono ? ' class="mono"' : ''}>${h(eq[f.key])}</dd></div>`).join('');
  return `
    <dl class="details">
      ${FIELDS.map((f) => `<div><dt>${f.label}</dt><dd${f.mono ? ' class="mono"' : ''}>${h(eq[f.key])}</dd></div>`).join('')}
      ${opt(EXTRA_FIELDS)}
      <div><dt>Date of calibration</dt><dd>${formatDate(eq.cal_date)}</dd></div>
      <div><dt>Calibration period</dt><dd>${formatPeriod(eq.cal_period)}</dd></div>
      <div><dt>Calibration due</dt><dd><strong>${formatMonth(due)}</strong> <span class="muted">· valid to ${formatDate(due)}, ${relative(due)}</span></dd></div>
      ${eq.result ? `<div><dt>Result</dt><dd><strong class="result-${h(eq.result)}">${h(cal.RESULTS[eq.result] || eq.result)}</strong></dd></div>` : ''}
      ${opt(CAL_DETAIL_FIELDS)}
      ${eq.remarks ? `<div><dt>Remarks</dt><dd style="white-space:pre-wrap">${h(eq.remarks)}</dd></div>` : ''}
    </dl>`;
}

// Reference instruments, readings and checks as tables (only the ones that have rows).
function detailTables(details) {
  return Object.entries(cal.TABLES).filter(([k]) => details[k] && details[k].length).map(([k, t]) => `
    <section class="panel">
      <div class="panel-head"><h2>${t.label}</h2></div>
      <div class="table-wrap"><table class="table">
        <thead><tr>${t.cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>${details[k].map((r) => `<tr>${t.cols.map(([c]) => `<td${['serial', 'cert'].includes(c) ? ' class="mono"' : ''}>${h(r[c]) || '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>`).join('');
}

const ADMIN_TABS = [
  ['users', '/admin/users', 'Users'],
  ['roles', '/admin/roles', 'Roles & permissions'],
  ['lists', '/admin/lists', 'Lists'],
  ['email', '/admin/email', 'Email (SMTP)'],
  ['reminders', '/admin/reminders', 'Reminders'],
  ['general', '/admin/general', 'General'],
  ['activity', '/admin/activity', 'Activity log'],
];

function adminShell(req, tab, title, body, { sub = '', actions = '' } = {}) {
  return layout({
    req,
    title,
    active: 'admin',
    wide: true,
    body: `
    <div class="admin">
      <aside class="admin-nav" aria-label="Admin sections">
        <div class="admin-nav-title">Admin</div>
        ${ADMIN_TABS.map(([k, href, label]) => `<a href="${href}" class="${k === tab ? 'active' : ''}"${k === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </aside>
      <section class="admin-main">
        ${pageHead(h(title), actions, sub)}
        ${body}
      </section>
    </div>`,
  });
}

module.exports = { h, icon, combo, layout, statusTag, statusOf, alert, pageHead, FIELDS, EXTRA_FIELDS, CAL_DETAIL_FIELDS, detailRows, detailTables, adminShell, soonDays, formatDate, dueDate };
