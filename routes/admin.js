const express = require('express');
const { db, tx } = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const reminders = require('../lib/reminders');
const lists = require('../lib/lists');
const site = require('../lib/site');
const { formatDate, formatMonth, formatDateTime, relative } = require('../lib/dates');
const { h, alert, adminShell, statusTag, icon, layout, pageHead } = require('../lib/views');
const { field, checked, requirePerm, notFound } = require('../lib/http');
const { validateIdentity } = require('./auth');

const router = express.Router();

// The activity log has its own permission, so it's registered before the admin-only gate below.
router.get('/admin/activity', requirePerm('audit.view'), (req, res) => {
  const PAGE = 100;
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ? OFFSET ?').all(PAGE, (page - 1) * PAGE);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const body = `
    <section class="panel">
      ${rows.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="log-time">${formatDateTime(r.at)}</td><td class="nowrap">${h(r.user_name)}</td><td class="nowrap">${h(r.action)}</td><td class="small">${h(r.detail)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${pages > 1 ? `<div class="pager">
        ${page > 1 ? `<a class="btn btn-sm" href="?page=${page - 1}">Newer</a>` : ''}
        <span class="muted small" style="align-self:center">Page ${page} of ${pages}</span>
        ${page < pages ? `<a class="btn btn-sm" href="?page=${page + 1}">Older</a>` : ''}
      </div>` : ''}` : '<div class="empty">No activity yet.</div>'}
    </section>`;
  if (req.user.can('users.manage')) return res.send(adminShell(req, 'activity', 'Activity log', body, { sub: 'Who changed what, and when.' }));
  res.send(layout({ req, title: 'Activity log', active: 'activity', wide: true, body: `${pageHead('Activity log', '', 'Who changed what, and when.')}${body}` }));
});

router.use('/admin', requirePerm('users.manage'));

router.get('/admin', (req, res) => res.redirect('/admin/users'));

const roleLabel = (r) => (auth.ROLES[r] ? auth.ROLES[r].label : r);
const roleOptions = (sel) => Object.entries(auth.ROLES).map(([k, r]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${r.label}</option>`).join('');
const linkUrl = (req, u) => `${site.baseUrl(req)}/invite/${u.invite_token}`;
const linkValid = (u) => u.invite_token && u.invite_expires > Date.now();

function userState(u) {
  if (!u.pass_hash) return linkValid(u) ? '<span class="tag tag-warn">Invite sent</span>' : '<span class="tag tag-bad">Invite expired</span>';
  if (u.disabled) return '<span class="tag">Disabled</span>';
  return '<span class="tag tag-accent">Active</span>';
}

// Would this change leave nobody able to administer the register?
function leavesNoAdmin(target, next) {
  if (!auth.isWorkingAdmin(target)) return false;
  const stillAdmin = !next.removed && next.role === 'admin' && !next.disabled;
  return !stillAdmin && auth.workingAdminCount() <= 1;
}

// ---------- users ----------
function usersPage(req, { error = '', notice = '', values = {} } = {}) {
  const users = db.prepare('SELECT * FROM users ORDER BY pass_hash IS NULL, disabled, name COLLATE NOCASE').all();
  const rows = users.map((u) => `
    <tr>
      <td><a class="cell-link" href="/admin/users/${u.id}">${h(u.name)}</a>${u.id === req.user.id ? ' <span class="muted small">(you)</span>' : ''}<span class="sub">${h(u.email)}</span></td>
      <td>${h(roleLabel(u.role))}</td>
      <td>${userState(u)}</td>
      <td>${u.notify ? 'Yes' : '<span class="muted">No</span>'}</td>
      <td class="nowrap muted">${u.last_login ? formatDateTime(u.last_login) : '—'}</td>
      <td class="actions"><a class="btn btn-sm" href="/admin/users/${u.id}">Manage</a></td>
    </tr>`).join('');
  const smtp = mailer.smtpConfigured();
  return adminShell(req, 'users', 'Users', `
    ${alert(notice, 'success')}
    <section class="panel">
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Reminders</th><th>Last log in</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section class="panel" id="invite">
      <div class="panel-head"><h2>Add a user</h2></div>
      <div class="panel-body">
        <p class="muted">They get a link to choose their own password. Links expire after ${auth.LINK_DAYS} days.</p>
        ${alert(error)}
        <form method="post" action="/admin/users" class="form">
          <div class="grid-2">
            <label class="field"><span>Name</span><input type="text" name="name" required maxlength="100" value="${h(values.name)}"></label>
            <label class="field"><span>Email</span><input type="email" name="email" required maxlength="200" value="${h(values.email)}"></label>
            <label class="field"><span>Role</span><select name="role">${roleOptions(values.role || 'editor')}</select><span class="hint">Change what each role can do under Roles &amp; permissions.</span></label>
            <div class="field" style="align-content:end;gap:10px">
              <label class="check"><input type="checkbox" name="notify" value="1" ${values.notify ? 'checked' : ''}><span>Send them calibration reminders</span></label>
              <label class="check"><input type="checkbox" name="send_email" value="1" ${smtp ? 'checked' : 'disabled'}><span>Email them the invite link${smtp ? '' : '<small>Set up Email (SMTP) to enable this. You can copy the link instead.</small>'}</span></label>
            </div>
          </div>
          <div><button class="btn btn-primary">${icon('plus')} Add user</button></div>
        </form>
      </div>
    </section>`, { sub: 'Who can log in, and what they can do.' });
}

router.get('/admin/users', (req, res) => res.send(usersPage(req)));

async function emailLink(req, u, kind) {
  const url = linkUrl(req, u);
  const name = site.appName();
  const subject = kind === 'invite' ? `You've been given access to ${name}` : `Reset your ${name} password`;
  const intro = kind === 'invite'
    ? `${req.user.name} has given you access to ${name}. Open this link to choose your password:`
    : `${req.user.name} has sent you a link to reset your ${name} password:`;
  await mailer.send({
    to: u.email,
    subject,
    text: `Hi ${u.name},\n\n${intro}\n\n${url}\n\nThe link expires in ${auth.LINK_DAYS} days.`,
    html: `<p>Hi ${h(u.name)},</p><p>${h(intro)}</p><p><a href="${h(url)}">${h(url)}</a></p><p style="color:#6f6b63">The link expires in ${auth.LINK_DAYS} days.</p>`,
  });
}

router.post('/admin/users', async (req, res) => {
  const name = field(req.body, 'name');
  const email = field(req.body, 'email').toLowerCase();
  const role = auth.ROLES[req.body.role] ? req.body.role : 'viewer';
  const notify = Number(checked(req.body, 'notify'));
  const err = validateIdentity(name, email);
  if (err) return res.status(400).send(usersPage(req, { error: err, values: { name, email, role, notify } }));
  const info = db.prepare('INSERT INTO users (name, email, role, notify, invite_token, invite_expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, email, role, notify, auth.randomToken(24), Date.now() + auth.LINK_DAYS * 864e5, Date.now());
  audit.log(req.user, 'Invited user', `${name} <${email}> as ${roleLabel(role)}`);
  let note = 'invited';
  if (req.body.send_email && mailer.smtpConfigured()) {
    try {
      await emailLink(req, db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid), 'invite');
      note = 'emailed';
    } catch (e) {
      note = `email-failed:${mailer.describeError(e)}`;
    }
  }
  res.redirect(`/admin/users/${info.lastInsertRowid}?n=${encodeURIComponent(note)}`);
});

function userPage(req, u, { error = '', notice = '' } = {}) {
  const isMe = u.id === req.user.id;
  const link = linkValid(u) ? linkUrl(req, u) : '';
  const smtp = mailer.smtpConfigured();
  const lastAdmin = auth.isWorkingAdmin(u) && auth.workingAdminCount() <= 1;
  return adminShell(req, 'users', u.name, `
    <a class="back" href="/admin/users">${icon('back', 14)} All users</a>
    ${alert(error)}${alert(notice, 'success')}
    ${link ? `
    <section class="panel">
      <div class="panel-head"><h2>${u.pass_hash ? 'Password reset link' : 'Invite link'}</h2><span class="muted small">Expires ${formatDateTime(u.invite_expires)}</span></div>
      <div class="panel-body">
        <p class="muted">Send this to ${h(u.name)}. Opening it lets them choose ${u.pass_hash ? 'a new' : 'their'} password. It works once.</p>
        <div class="copy-row"><input type="text" id="link" readonly value="${h(link)}"><button type="button" class="btn" data-copy="link">${icon('link')} Copy</button></div>
      </div>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>Details</h2>${userState(u)}</div>
      <form method="post" action="/admin/users/${u.id}">
        <div class="panel-body form">
          <div class="grid-2">
            <label class="field"><span>Name</span><input type="text" name="name" required maxlength="100" value="${h(u.name)}"></label>
            <label class="field"><span>Email</span><input type="email" name="email" required maxlength="200" value="${h(u.email)}"></label>
            <label class="field"><span>Role</span><select name="role" ${lastAdmin ? 'disabled' : ''}>${roleOptions(u.role)}</select>
              ${lastAdmin ? '<input type="hidden" name="role" value="admin"><span class="hint">This is the only admin, so the role can\'t be changed.</span>' : `<span class="hint">${h(auth.ROLES[u.role] ? auth.ROLES[u.role].description : '')}</span>`}</label>
            <div class="field" style="align-content:end;gap:10px">
              <label class="check"><input type="checkbox" name="notify" value="1" ${u.notify ? 'checked' : ''}><span>Receives calibration reminders</span></label>
              ${lastAdmin || isMe ? `<input type="hidden" name="disabled" value="${u.disabled ? '1' : ''}">` : `
              <label class="check"><input type="checkbox" name="disabled" value="1" ${u.disabled ? 'checked' : ''}><span>Disable this account<small>They can't log in until it's turned back on.</small></span></label>`}
            </div>
          </div>
        </div>
        <div class="panel-foot"><button class="btn btn-primary">Save changes</button></div>
      </form>
    </section>
    <div class="grid-2" style="align-items:start">
      <section class="panel">
        <div class="panel-head"><h2>${u.pass_hash ? 'Reset password' : 'New invite link'}</h2></div>
        <div class="panel-body">
          <p class="muted">${u.pass_hash ? 'Creates a one-time link they can use to set a new password. Their current password keeps working until they use it.' : 'Creates a fresh invite link and cancels the old one.'}</p>
          <form method="post" action="/admin/users/${u.id}/link" class="form">
            <label class="check"><input type="checkbox" name="send_email" value="1" ${smtp ? 'checked' : 'disabled'}><span>Email it to ${h(u.email)}${smtp ? '' : '<small>Email isn\'t set up. You can copy the link instead.</small>'}</span></label>
            <div><button class="btn">${u.pass_hash ? 'Create reset link' : 'Create new invite link'}</button></div>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Remove user</h2></div>
        <div class="panel-body">
          ${lastAdmin ? '<p class="muted">This is the only admin, so they can\'t be removed. Make someone else an admin first.</p>' : `
          <p class="muted">Removes their access straight away and logs them out. The activity log keeps their name.</p>
          <form method="post" action="/admin/users/${u.id}/remove" data-confirm="Remove ${h(u.name)}? They will be logged out straight away.">
            <button class="btn btn-danger">Remove ${isMe ? 'my account' : 'user'}</button>
          </form>`}
        </div>
      </section>
    </div>
    <p class="small muted">Added ${formatDateTime(u.created_at)}${u.last_login ? ` · Last logged in ${formatDateTime(u.last_login)}` : ''}</p>`);
}

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));

router.get('/admin/users/:id', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return notFound(req, res);
  const n = typeof req.query.n === 'string' ? req.query.n : '';
  let notice = '', error = '';
  if (n === 'invited') notice = 'User added. Copy the invite link below and send it to them.';
  else if (n === 'emailed') notice = `Invite emailed to ${u.email}.`;
  else if (n === 'link') notice = 'New link created. Copy it below and send it to them.';
  else if (n === 'link-emailed') notice = `Link emailed to ${u.email}.`;
  else if (n.startsWith('email-failed:')) error = `The user was added, but the email didn't send: ${n.slice(13)} Copy the link below instead.`;
  else if (n.startsWith('link-failed:')) error = `The link was created, but the email didn't send: ${n.slice(12)} Copy the link below instead.`;
  res.send(userPage(req, u, { notice, error }));
});

router.post('/admin/users/:id', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return notFound(req, res);
  const name = field(req.body, 'name');
  const email = field(req.body, 'email').toLowerCase();
  const role = auth.ROLES[req.body.role] ? req.body.role : u.role;
  const notify = Number(checked(req.body, 'notify'));
  let disabled = Number(checked(req.body, 'disabled'));
  if (u.id === req.user.id) disabled = 0; // you can't lock yourself out
  const err = validateIdentity(name, email, u.id);
  if (err) return res.status(400).send(userPage(req, u, { error: err }));
  if (leavesNoAdmin(u, { role, disabled })) {
    return res.status(400).send(userPage(req, u, { error: 'There must always be at least one active admin. Make someone else an admin first.' }));
  }
  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, notify = ?, disabled = ? WHERE id = ?').run(name, email, role, notify, disabled, u.id);
  if (disabled && !u.disabled) auth.endSessionsFor(u.id);
  const changes = [];
  if (role !== u.role) changes.push(`role ${roleLabel(u.role)} → ${roleLabel(role)}`);
  if (disabled !== u.disabled) changes.push(disabled ? 'disabled' : 're-enabled');
  if (email !== u.email) changes.push(`email → ${email}`);
  audit.log(req.user, 'Updated user', `${name}${changes.length ? `: ${changes.join(', ')}` : ''}`);
  res.send(userPage(req, getUser(u.id), { notice: 'Changes saved.' }));
});

router.post('/admin/users/:id/link', async (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return notFound(req, res);
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(auth.randomToken(24), Date.now() + auth.LINK_DAYS * 864e5, u.id);
  audit.log(req.user, u.pass_hash ? 'Created password reset link' : 'Created new invite link', u.name);
  let n = 'link';
  if (req.body.send_email && mailer.smtpConfigured()) {
    try {
      await emailLink(req, getUser(u.id), u.pass_hash ? 'reset' : 'invite');
      n = 'link-emailed';
    } catch (e) {
      n = `link-failed:${mailer.describeError(e)}`;
    }
  }
  res.redirect(`/admin/users/${u.id}?n=${encodeURIComponent(n)}`);
});

router.post('/admin/users/:id/remove', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.redirect('/admin/users');
  if (leavesNoAdmin(u, { removed: true })) {
    return res.status(400).send(userPage(req, u, { error: "You can't remove the only admin, or nobody could manage the register." }));
  }
  tx(() => {
    auth.endSessionsFor(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  });
  audit.log(req.user, 'Removed user', `${u.name} <${u.email}>`);
  if (u.id === req.user.id) {
    res.clearCookie('sid', { path: '/' });
    return res.redirect('/login');
  }
  res.send(usersPage(req, { notice: `${u.name} has been removed.` }));
});

// ---------- roles & permissions ----------
function rolesPage(req, notice = '') {
  const editable = Object.keys(auth.ROLES).filter((r) => r !== 'admin');
  const sets = Object.fromEntries(Object.keys(auth.ROLES).map((r) => [r, auth.permsFor(r)]));
  const counts = Object.fromEntries(db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all().map((r) => [r.role, r.c]));
  const head = Object.entries(auth.ROLES).map(([k, r]) => `<th>${r.label}<div class="muted small" style="text-transform:none;letter-spacing:0;font-weight:400">${counts[k] || 0} user${counts[k] === 1 ? '' : 's'}</div></th>`).join('');
  const rows = Object.entries(auth.PERMISSIONS).map(([p, label]) => `
    <tr>
      <td>${h(label)}<small class="mono">${p}</small></td>
      <td><input type="checkbox" checked disabled aria-label="Admin: ${h(label)}"></td>
      ${editable.map((r) => `<td><input type="checkbox" name="${r}" value="${p}" ${sets[r].has(p) ? 'checked' : ''} aria-label="${h(auth.ROLES[r].label)}: ${h(label)}"></td>`).join('')}
    </tr>`).join('');
  return adminShell(req, 'roles', 'Roles & permissions', `
    ${alert(notice, 'success')}
    <form method="post" action="/admin/roles" class="panel">
      <div class="table-wrap">
        <table class="table matrix">
          <thead><tr><th>Permission</th>${head}</tr></thead>
          <tbody>
            ${rows}
            <tr><td>Manage users, roles and settings<small>Admin only, so nobody can lock the admins out.</small></td><td><input type="checkbox" checked disabled aria-label="Admin manages users"></td>${editable.map(() => '<td><input type="checkbox" disabled aria-label="Not available"></td>').join('')}</tr>
          </tbody>
        </table>
      </div>
      <div class="panel-foot"><button class="btn btn-primary">Save permissions</button><span class="muted small">Changes apply straight away, including to people who are logged in.</span></div>
    </form>
    <p class="small muted">Anyone can open the page a QR code points to (read-only). That doesn't need a login or a permission.</p>`,
  { sub: 'Choose what Editors and Viewers can do. Assign roles on the Users page.' });
}

router.get('/admin/roles', (req, res) => res.send(rolesPage(req)));

router.post('/admin/roles', (req, res) => {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  tx(() => {
    for (const r of Object.keys(auth.ROLES)) if (r !== 'admin') auth.setRolePerms(r, list(req.body[r]));
  });
  audit.log(req.user, 'Changed role permissions', Object.keys(auth.ROLES).filter((r) => r !== 'admin').map((r) => `${roleLabel(r)}: ${[...auth.permsFor(r)].join(', ') || 'none'}`).join(' · '));
  res.send(rolesPage(req, 'Permissions saved.'));
});

// ---------- email (SMTP) ----------
function emailPage(req, { error = '', notice = '', testError = '', testNotice = '' } = {}) {
  const s = (k) => h(settings.get(k));
  const sec = settings.get('smtp_security');
  const hasPass = settings.has('smtp_pass');
  return adminShell(req, 'email', 'Email (SMTP)', `
    ${mailer.smtpConfigured() ? '' : alert('Email isn\'t set up yet. Fill in your mail server details to send reminders and invite links.', 'info')}
    ${alert(error)}${alert(notice, 'success')}
    <form method="post" action="/admin/email" class="panel" autocomplete="off">
      <div class="panel-head"><h2>Mail server</h2></div>
      <div class="panel-body form">
        <div class="grid-2">
          <label class="field"><span>SMTP host</span><input type="text" name="smtp_host" value="${s('smtp_host')}" placeholder="smtp.office365.com"></label>
          <div class="grid-2" style="gap:12px">
            <label class="field"><span>Security</span><select name="smtp_security" id="smtp_security">
              <option value="starttls" ${sec === 'starttls' ? 'selected' : ''}>STARTTLS</option>
              <option value="ssl" ${sec === 'ssl' ? 'selected' : ''}>SSL/TLS</option>
              <option value="none" ${sec === 'none' ? 'selected' : ''}>None</option>
            </select></label>
            <label class="field"><span>Port</span><input type="number" name="smtp_port" id="smtp_port" min="1" max="65535" value="${s('smtp_port')}"></label>
          </div>
          <label class="field"><span>Username</span><input type="text" name="smtp_user" value="${s('smtp_user')}" autocomplete="off"><span class="hint">Leave blank if your server doesn't need a login.</span></label>
          <label class="field"><span>Password</span><input type="password" name="smtp_pass" value="" placeholder="${hasPass ? 'Saved. Leave blank to keep it' : ''}" autocomplete="new-password">
            <span class="hint">${hasPass ? 'A password is saved (stored encrypted).' : 'Stored encrypted. For Gmail or Microsoft 365, use an app password.'}</span></label>
          <label class="field"><span>Send from</span><input type="text" name="smtp_from" value="${s('smtp_from')}" placeholder="Calibration Register &lt;calibration@yourcompany.com&gt;"></label>
          ${hasPass ? '<div class="field" style="align-content:end"><label class="check"><input type="checkbox" name="clear_pass" value="1"><span>Remove the saved password</span></label></div>' : ''}
        </div>
      </div>
      <div class="panel-foot"><button class="btn btn-primary">Save</button></div>
    </form>
    <section class="panel">
      <div class="panel-head"><h2>Send a test email</h2></div>
      <div class="panel-body">
        ${alert(testError)}${alert(testNotice, 'success')}
        <form method="post" action="/admin/email/test" class="toolbar" style="margin:0">
          <input type="email" name="to" required value="${h(req.user.email)}" style="flex:1 1 260px;width:auto" aria-label="Send test to">
          <button class="btn" ${mailer.smtpConfigured() ? '' : 'disabled'}>${icon('mail')} Send test</button>
        </form>
      </div>
    </section>
    <details class="panel"><summary class="panel-body" style="cursor:pointer">Common settings</summary>
      <div class="panel-body" style="padding-top:0">
        <dl class="kv">
          <dt>Microsoft 365</dt><dd><span class="mono">smtp.office365.com</span>, STARTTLS, port 587</dd>
          <dt>Gmail / Google Workspace</dt><dd><span class="mono">smtp.gmail.com</span>, STARTTLS 587 or SSL 465 (needs an app password)</dd>
          <dt>Outlook.com</dt><dd><span class="mono">smtp-mail.outlook.com</span>, STARTTLS, port 587</dd>
        </dl>
      </div>
    </details>`, { sub: 'Used for reminder emails and invite links.' });
}

router.get('/admin/email', (req, res) => res.send(emailPage(req)));

router.post('/admin/email', (req, res) => {
  const host = field(req.body, 'smtp_host');
  const port = Number(field(req.body, 'smtp_port'));
  const security = ['starttls', 'ssl', 'none'].includes(req.body.smtp_security) ? req.body.smtp_security : 'starttls';
  const from = field(req.body, 'smtp_from');
  if (host && (!Number.isInteger(port) || port < 1 || port > 65535)) return res.status(400).send(emailPage(req, { error: 'Port must be a number between 1 and 65535.' }));
  if (host && !/@/.test(from)) return res.status(400).send(emailPage(req, { error: 'Please enter a "Send from" email address.' }));
  settings.set('smtp_host', host);
  settings.set('smtp_port', String(port || 587));
  settings.set('smtp_security', security);
  settings.set('smtp_user', field(req.body, 'smtp_user'));
  settings.set('smtp_from', from);
  if (req.body.clear_pass) settings.set('smtp_pass', '');
  else if (typeof req.body.smtp_pass === 'string' && req.body.smtp_pass !== '') settings.set('smtp_pass', req.body.smtp_pass);
  audit.log(req.user, 'Changed email settings', host ? `${host}:${port} (${security})` : 'cleared');
  res.send(emailPage(req, { notice: 'Email settings saved. Send a test email to check them.' }));
});

router.post('/admin/email/test', async (req, res) => {
  const to = field(req.body, 'to');
  if (!reminders.EMAIL_RE.test(to)) return res.status(400).send(emailPage(req, { testError: 'Enter a valid address to send the test to.' }));
  try {
    await mailer.send({
      to,
      subject: `Test email from ${site.appName()}`,
      text: `This is a test email from ${site.appName()}. If you can read this, email is set up correctly.`,
      html: `<p>This is a test email from <strong>${h(site.appName())}</strong>.</p><p>If you can read this, email is set up correctly.</p>`,
    });
    audit.log(req.user, 'Sent test email', to);
    res.send(emailPage(req, { testNotice: `Test email sent to ${to}. Check that inbox (and the junk folder).` }));
  } catch (e) {
    res.status(502).send(emailPage(req, { testError: `The test email didn't send. ${mailer.describeError(e)}` }));
  }
});

// ---------- reminders ----------
function remindersPage(req, { error = '', notice = '' } = {}) {
  const smtp = mailer.smtpConfigured();
  const enabled = settings.bool('reminders_enabled');
  const hour = settings.num('reminder_hour');
  const recipients = reminders.globalRecipients();
  const pending = reminders.pendingItems();
  const last = reminders.lastResult();
  const hours = Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === hour ? 'selected' : ''}>${String(i).padStart(2, '0')}:00</option>`).join('');
  const pendingRows = pending.map((i) => `
    <tr>
      <td class="mono nowrap">${h(i.cert_no)}</td>
      <td>${h(i.type)}<span class="sub">${h(i.owner)} · ${h(i.department)}</span></td>
      <td class="nowrap">${formatMonth(i.due)}<span class="sub">${relative(i.due)}</span></td>
      <td>${statusTag(i)}</td>
      <td class="small">${settings.bool('reminder_contacts') && i.contact_email ? h(i.contact_email) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  return adminShell(req, 'reminders', 'Reminders', `
    ${smtp ? '' : alert('Set up Email (SMTP) first. Reminders can\'t be sent until it works.', 'warn')}
    ${alert(error)}${alert(notice, 'success')}
    <section class="panel">
      <div class="panel-head"><h2>Status</h2>${enabled && smtp ? '<span class="tag tag-accent">On</span>' : '<span class="tag">Off</span>'}</div>
      <div class="panel-body">
        <dl class="kv">
          <dt>Schedule</dt><dd>${enabled ? `Every day after ${String(hour).padStart(2, '0')}:00, while the app is running` : 'Not scheduled'}</dd>
          <dt>Recipients</dt><dd>${recipients.length ? recipients.map(h).join(', ') : '<span class="muted">Nobody yet. Tick "Receives calibration reminders" on a user, or add addresses below.</span>'}${settings.bool('reminder_contacts') ? '<br><span class="muted small">Plus each item\'s contact email, for that item only.</span>' : ''}</dd>
          <dt>Last run</dt><dd>${last ? `${formatDateTime(last.at)}: ${h(last.message)}` : '<span class="muted">Never</span>'}</dd>
        </dl>
      </div>
    </section>
    <form method="post" action="/admin/reminders" class="panel">
      <div class="panel-head"><h2>Settings</h2></div>
      <div class="panel-body form">
        <label class="check"><input type="checkbox" name="reminders_enabled" value="1" ${enabled ? 'checked' : ''}><span>Send reminder emails automatically<small>One email per person per day, listing everything that has reached a reminder point.</small></span></label>
        <div class="grid-2">
          <label class="field"><span>Remind this many days before the due date</span><input type="text" name="reminder_days" value="${h(reminders.parseDays(settings.get('reminder_days')).reverse().join(', '))}" placeholder="30, 7, 1"><span class="hint">Separate with commas. Each item is reminded once at each point.</span></label>
          <label class="field"><span>Send at</span><select name="reminder_hour">${hours}</select><span class="hint">Local time on the computer running the app.</span></label>
          <label class="field span-2"><span>Also send to these addresses</span><textarea name="reminder_recipients" rows="2" placeholder="quality@yourcompany.com, workshop@yourcompany.com">${h(reminders.parseEmails(settings.get('reminder_recipients')).join(', '))}</textarea><span class="hint">For people who don't need a login. Users with reminders ticked are included automatically.</span></label>
        </div>
        <label class="check"><input type="checkbox" name="reminder_overdue" value="1" ${settings.bool('reminder_overdue') ? 'checked' : ''}><span>Send one more reminder when an item becomes overdue</span></label>
        <label class="check"><input type="checkbox" name="reminder_contacts" value="1" ${settings.bool('reminder_contacts') ? 'checked' : ''}><span>Email each item's contact address about that item<small>Set on the equipment form (optional).</small></span></label>
      </div>
      <div class="panel-foot"><button class="btn btn-primary">Save</button></div>
    </form>
    <section class="panel">
      <div class="panel-head">
        <h2>Due for a reminder now</h2>
        <form method="post" action="/admin/reminders/run" data-confirm="Send reminder emails for these ${pending.length} item(s) now?" class="inline">
          <button class="btn btn-sm" ${smtp && pending.length ? '' : 'disabled'}>${icon('mail')} Send now</button>
        </form>
      </div>
      ${pending.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Certificate</th><th>Equipment</th><th>Due</th><th>Status</th><th>Contact</th></tr></thead>
        <tbody>${pendingRows}</tbody>
      </table></div>` : '<div class="empty">Nothing needs a reminder right now.</div>'}
    </section>`, { sub: 'Automatic emails before calibration runs out.' });
}

router.get('/admin/reminders', (req, res) => res.send(remindersPage(req)));

router.post('/admin/reminders', (req, res) => {
  const days = reminders.parseDays(req.body.reminder_days);
  if (!days.length) return res.status(400).send(remindersPage(req, { error: 'Enter at least one number of days, e.g. 30, 7, 1.' }));
  const hour = Number(req.body.reminder_hour);
  settings.set('reminders_enabled', checked(req.body, 'reminders_enabled'));
  settings.set('reminder_days', days.join(','));
  settings.set('reminder_hour', String(Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 8));
  settings.set('reminder_recipients', reminders.parseEmails(req.body.reminder_recipients).join(','));
  settings.set('reminder_overdue', checked(req.body, 'reminder_overdue'));
  settings.set('reminder_contacts', checked(req.body, 'reminder_contacts'));
  audit.log(req.user, 'Changed reminder settings', `${settings.bool('reminders_enabled') ? 'on' : 'off'}; days ${days.join(', ')}`);
  let notice = 'Reminder settings saved.';
  if (settings.bool('reminders_enabled') && !mailer.smtpConfigured()) notice += ' Reminders will start once Email (SMTP) is set up.';
  res.send(remindersPage(req, { notice }));
});

router.post('/admin/reminders/run', async (req, res) => {
  if (!mailer.smtpConfigured()) return res.status(400).send(remindersPage(req, { error: 'Set up Email (SMTP) first.' }));
  try {
    const r = await reminders.run({ user: req.user });
    if (r.failures.length && !r.emails) return res.status(502).send(remindersPage(req, { error: r.message }));
    res.send(remindersPage(req, { notice: r.message }));
  } catch (e) {
    res.status(500).send(remindersPage(req, { error: `Reminders failed: ${mailer.describeError(e)}` }));
  }
});

// ---------- lists (types, owners, departments, manufacturers) ----------
function listsPage(req, { error = '', notice = '', open = '' } = {}) {
  const sections = Object.entries(lists.KINDS).map(([kind, k]) => {
    const rows = lists.usage(kind);
    return `
    <section class="panel" id="${kind}">
      <div class="panel-head"><h2>${k.label}</h2><span class="muted small">${rows.length} saved</span></div>
      <div class="panel-body" style="padding-bottom:12px">
        <form method="post" action="/admin/lists/${kind}/add" class="toolbar" style="margin:0">
          <input type="text" name="value" required maxlength="200" placeholder="New ${k.one}" aria-label="New ${k.one}" style="flex:1 1 240px;width:auto" ${open === kind ? 'autofocus' : ''}>
          <button class="btn">${icon('plus')} Add</button>
        </form>
      </div>
      ${rows.length ? `
      <div class="table-wrap"><table class="table table-edit">
        <thead><tr><th>Name</th><th>Used by</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td>
              <form method="post" action="/admin/lists/${kind}/rename" class="rename-row" data-confirm="${r.count ? `Rename this ${k.one}? All ${r.count} item${r.count === 1 ? '' : 's'} using it will be updated.` : ''}">
                <input type="hidden" name="from" value="${h(r.value)}">
                <input type="text" name="to" value="${h(r.value)}" required maxlength="200" aria-label="Rename ${h(r.value)}">
                <button class="btn btn-sm">Rename</button>
              </form>
            </td>
            <td class="nowrap">${r.count ? `<a href="/equipment?${kind}=${encodeURIComponent(r.value)}">${r.count} item${r.count === 1 ? '' : 's'}</a>` : '<span class="muted">Not used</span>'}</td>
            <td class="actions">${r.count ? '' : `
              <form method="post" action="/admin/lists/${kind}/remove" class="inline">
                <input type="hidden" name="value" value="${h(r.value)}"><button class="btn btn-sm btn-quiet" title="Remove from the list">Remove</button>
              </form>`}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty" style="padding:18px">No ${k.label.toLowerCase()} yet.</div>`}
    </section>`;
  }).join('');
  return adminShell(req, 'lists', 'Lists', `
    ${alert(error)}${alert(notice, 'success')}
    <nav class="chips" aria-label="Jump to list">${Object.entries(lists.KINDS).map(([kind, k]) => `<a class="filter-chip" href="#${kind}" style="padding-right:10px">${k.label}</a>`).join('')}</nav>
    ${sections}`, { sub: 'The choices in the dropdowns on the equipment form. New values typed on the form are added here automatically.' });
}

router.get('/admin/lists', (req, res) => res.send(listsPage(req)));

router.post('/admin/lists/:kind/:action', (req, res) => {
  const { kind, action } = req.params;
  const k = lists.KINDS[kind];
  if (!k || !['add', 'rename', 'remove'].includes(action)) return notFound(req, res);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (action === 'add') {
    const value = clean(req.body.value);
    if (!value) return res.status(400).send(listsPage(req, { error: 'Type a name to add.', open: kind }));
    const added = lists.add(kind, value);
    if (added) audit.log(req.user, 'Added to list', `${k.label}: ${value}`);
    return res.send(listsPage(req, { notice: added ? `Added "${value}" to ${k.label.toLowerCase()}.` : `"${value}" is already in the list.`, open: kind }));
  }
  if (action === 'rename') {
    const from = clean(req.body.from);
    const to = clean(req.body.to);
    if (!from || !to) return res.status(400).send(listsPage(req, { error: 'The new name can\'t be blank.' }));
    if (from === to) return res.send(listsPage(req));
    const n = lists.rename(kind, from, to);
    audit.log(req.user, 'Renamed list value', `${k.label}: "${from}" → "${to}" (${n} items updated)`);
    return res.send(listsPage(req, { notice: `Renamed "${from}" to "${to}"${n ? ` and updated ${n} item${n === 1 ? '' : 's'}` : ''}.` }));
  }
  const value = clean(req.body.value);
  const used = lists.remove(kind, value);
  if (used) return res.status(400).send(listsPage(req, { error: `"${value}" is used by ${used} item${used === 1 ? '' : 's'}, so it can't be removed. Rename it instead, or change those items first.` }));
  audit.log(req.user, 'Removed from list', `${k.label}: ${value}`);
  res.send(listsPage(req, { notice: `Removed "${value}".` }));
});

// ---------- general ----------
function generalPage(req, { error = '', notice = '' } = {}) {
  const envUrl = site.ENV_BASE_URL;
  return adminShell(req, 'general', 'General', `
    ${alert(error)}${alert(notice, 'success')}
    <form method="post" action="/admin/general" class="panel">
      <div class="panel-body form">
        <label class="field"><span>Register name</span><input type="text" name="app_name" required maxlength="60" value="${h(settings.get('app_name'))}"><span class="hint">Shown in the top bar, on labels and in emails.</span></label>
        <label class="field"><span>Site address</span>
          <input type="url" name="site_url" value="${h(envUrl || settings.get('site_url'))}" placeholder="https://calibration.yourcompany.com" ${envUrl ? 'disabled' : ''}>
          <span class="hint">${envUrl ? 'Set by the BASE_URL setting on the server.' : `The public address QR codes and email links point to. Leave blank while trialling (uses <span class="mono">${h(site.LAN_URL)}</span>).`} <strong>Set this before printing permanent labels.</strong></span></label>
        <label class="field"><span>Show "Due soon" this many days before the due date</span><input type="number" name="due_soon_days" min="1" max="365" value="${settings.num('due_soon_days')}" style="max-width:120px"></label>
      </div>
      <div class="panel-foot"><button class="btn btn-primary">Save</button></div>
    </form>`, { sub: 'Name, address and display options.' });
}

router.get('/admin/general', (req, res) => res.send(generalPage(req)));

router.post('/admin/general', (req, res) => {
  const name = field(req.body, 'app_name');
  const url = field(req.body, 'site_url').replace(/\/+$/, '');
  const soon = Number(req.body.due_soon_days);
  if (!name || name.length > 60) return res.status(400).send(generalPage(req, { error: 'Please enter a register name (up to 60 characters).' }));
  if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) return res.status(400).send(generalPage(req, { error: 'Site address must start with http:// or https://' }));
  if (!Number.isInteger(soon) || soon < 1 || soon > 365) return res.status(400).send(generalPage(req, { error: '"Due soon" days must be between 1 and 365.' }));
  settings.set('app_name', name);
  if (!site.ENV_BASE_URL) settings.set('site_url', url);
  settings.set('due_soon_days', String(soon));
  audit.log(req.user, 'Changed general settings', `name "${name}", address ${url || '(trial)'}, due soon ${soon} days`);
  res.send(generalPage(req, { notice: 'Saved.' }));
});

module.exports = { router };
