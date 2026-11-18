const express = require('express');
const { db } = require('../lib/db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const site = require('../lib/site');
const { h, layout, alert, pageHead } = require('../lib/views');
const { field, checked, safeNext, requireLogin, homeFor } = require('../lib/http');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authPage(req, title, sub, inner) {
  return layout({
    req,
    title,
    bare: true,
    body: `<section class="panel narrow auth"><div class="panel-body">
      <h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}${inner}
    </div></section>`,
  });
}

// ---------- first-run setup (only while there are no users) ----------
function setupPage(req, error = '', v = {}) {
  return authPage(req, 'Set up the register', 'Create the first admin account. You can add other people afterwards.', `
    ${alert(error)}
    <form method="post" action="/setup" class="form">
      <label class="field"><span>Your name</span><input type="text" name="name" required maxlength="100" value="${h(v.name)}" autocomplete="name"></label>
      <label class="field"><span>Email</span><input type="email" name="email" required maxlength="200" value="${h(v.email)}" autocomplete="email"></label>
      <label class="field"><span>Password</span><input type="password" name="password" required minlength="${auth.MIN_PASSWORD}" autocomplete="new-password"><span class="hint">At least ${auth.MIN_PASSWORD} characters.</span></label>
      <label class="field"><span>Confirm password</span><input type="password" name="confirm" required autocomplete="new-password"></label>
      <button class="btn btn-primary">Create admin account</button>
    </form>`);
}

router.get('/setup', (req, res) => {
  if (auth.userCount() > 0) return res.redirect('/login');
  res.send(setupPage(req));
});

router.post('/setup', (req, res) => {
  if (auth.userCount() > 0) return res.redirect('/login');
  const name = field(req.body, 'name');
  const email = field(req.body, 'email').toLowerCase();
  const err = validateIdentity(name, email) || auth.validatePassword(req.body.password, req.body.confirm);
  if (err) return res.status(400).send(setupPage(req, err, { name, email }));
  const info = db.prepare("INSERT INTO users (name, email, pass_hash, role, notify, created_at) VALUES (?, ?, ?, 'admin', 1, ?)")
    .run(name, email, auth.hashPassword(req.body.password), Date.now());
  audit.log({ id: info.lastInsertRowid, name }, 'Set up the register');
  auth.createSession(res, info.lastInsertRowid, site.secureCookies());
  res.redirect('/equipment');
});

function validateIdentity(name, email, exceptId = 0) {
  if (!name) return 'Please enter a name.';
  if (name.length > 100) return 'Name is too long.';
  if (!EMAIL_RE.test(email) || email.length > 200) return 'Please enter a valid email address.';
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId)) return 'Someone already uses that email address.';
  return '';
}

// ---------- login / logout ----------
function loginPage(req, error = '', email = '', next = '') {
  return authPage(req, 'Log in', `Sign in to ${h(site.appName())}.`, `
    ${alert(error)}
    <form method="post" action="/login" class="form">
      <input type="hidden" name="next" value="${h(next)}">
      <label class="field"><span>Email</span><input type="email" name="email" required value="${h(email)}" autocomplete="username" autofocus></label>
      <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary">Log in</button>
      <p class="small muted" style="margin:0">Forgotten your password? Ask an admin for a reset link.</p>
    </form>`);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next, homeFor(req.user)));
  if (auth.userCount() === 0) return res.redirect('/setup');
  res.send(loginPage(req, '', '', typeof req.query.next === 'string' ? req.query.next : ''));
});

router.post('/login', (req, res) => {
  const email = field(req.body, 'email').toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = auth.throttleKey(req, email);
  if (auth.isThrottled(key)) {
    return res.status(429).send(loginPage(req, 'Too many failed attempts. Wait 15 minutes and try again.', email, req.body.next));
  }
  const row = db.prepare('SELECT id, name, role, pass_hash, disabled FROM users WHERE email = ?').get(email);
  if (!row || !auth.checkPassword(password, row.pass_hash)) {
    auth.recordFailure(key);
    return res.status(401).send(loginPage(req, 'Email or password is incorrect.', email, req.body.next));
  }
  if (row.disabled) return res.status(403).send(loginPage(req, 'This account has been disabled. Ask an admin to turn it back on.', email));
  auth.clearFailures(key);
  auth.purgeExpired();
  auth.createSession(res, row.id, site.secureCookies());
  const home = auth.permsFor(row.role).has('equipment.view') ? '/equipment' : '/account';
  res.redirect(safeNext(req.body.next, home));
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/login');
});

// ---------- invite & password-reset links ----------
const linkRow = (token) => db.prepare('SELECT * FROM users WHERE invite_token = ? AND invite_expires > ?').get(token, Date.now());

function linkPage(req, u, error = '') {
  const isInvite = !u.pass_hash;
  return authPage(req, isInvite ? `Welcome, ${h(u.name)}` : 'Choose a new password',
    isInvite ? `You've been given access to ${h(site.appName())}. Choose a password for <strong>${h(u.email)}</strong> to finish.` : `Resetting the password for <strong>${h(u.email)}</strong>.`, `
    ${alert(error)}
    <form method="post" class="form">
      <label class="field"><span>New password</span><input type="password" name="password" required minlength="${auth.MIN_PASSWORD}" autocomplete="new-password"><span class="hint">At least ${auth.MIN_PASSWORD} characters.</span></label>
      <label class="field"><span>Confirm password</span><input type="password" name="confirm" required autocomplete="new-password"></label>
      <button class="btn btn-primary">Save password</button>
    </form>`);
}

const deadLink = (req) => authPage(req, "This link isn't valid", 'It has expired, been used already, or been replaced by a newer link. Ask an admin to send you a new one.', '');

router.get('/invite/:token', (req, res) => {
  const u = linkRow(req.params.token);
  if (!u) return res.status(404).send(deadLink(req));
  res.send(linkPage(req, u));
});

router.post('/invite/:token', (req, res) => {
  const u = linkRow(req.params.token);
  if (!u) return res.status(404).send(deadLink(req));
  const err = auth.validatePassword(req.body.password, req.body.confirm);
  if (err) return res.status(400).send(linkPage(req, u, err));
  const wasInvite = !u.pass_hash;
  db.prepare('UPDATE users SET pass_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?').run(auth.hashPassword(req.body.password), u.id);
  auth.endSessionsFor(u.id); // a reset logs out every other device
  audit.log(u, wasInvite ? 'Accepted invite' : 'Reset password');
  if (u.disabled) return res.redirect('/login');
  auth.createSession(res, u.id, site.secureCookies());
  res.redirect(auth.permsFor(u.role).has('equipment.view') ? '/equipment' : '/account');
});

// ---------- your account ----------
function accountPage(req, { error = '', notice = '', pwError = '', pwNotice = '' } = {}) {
  const u = req.user;
  return layout({
    req,
    title: 'Your account',
    active: 'account',
    body: `
    ${pageHead('Your account', '', `${h(u.email)} · ${h(auth.ROLES[u.role] ? auth.ROLES[u.role].label : u.role)}`)}
    <div class="grid-2" style="align-items:start">
      <section class="panel">
        <div class="panel-head"><h2>Profile</h2></div>
        <div class="panel-body">
          ${alert(error)}${alert(notice, 'success')}
          <form method="post" action="/account" class="form">
            <label class="field"><span>Name</span><input type="text" name="name" required maxlength="100" value="${h(u.name)}"></label>
            <label class="check"><input type="checkbox" name="notify" value="1" ${u.notify ? 'checked' : ''}><span>Email me calibration reminders<small>You'll get the daily reminder email when equipment is coming due.</small></span></label>
            <div><button class="btn btn-primary">Save</button></div>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Change password</h2></div>
        <div class="panel-body">
          ${alert(pwError)}${alert(pwNotice, 'success')}
          <form method="post" action="/account/password" class="form">
            <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
            <label class="field"><span>New password</span><input type="password" name="password" required minlength="${auth.MIN_PASSWORD}" autocomplete="new-password"></label>
            <label class="field"><span>Confirm new password</span><input type="password" name="confirm" required autocomplete="new-password"></label>
            <div><button class="btn">Change password</button></div>
          </form>
        </div>
      </section>
      <section class="panel span-2">
        <div class="panel-head"><h2>Appearance</h2></div>
        <div class="panel-body">
          <fieldset class="radio-row" aria-label="Theme">
            <label class="check"><input type="radio" name="theme_choice" value="light"><span>Light</span></label>
            <label class="check"><input type="radio" name="theme_choice" value="dark"><span>Dark</span></label>
            <label class="check"><input type="radio" name="theme_choice" value="system"><span>Match this device</span></label>
          </fieldset>
          <p class="small muted" style="margin:10px 0 0">Saved in this browser. You can also switch with the button in the top bar.</p>
        </div>
      </section>
    </div>`,
  });
}

router.get('/account', requireLogin, (req, res) => res.send(accountPage(req)));

router.post('/account', requireLogin, (req, res) => {
  const name = field(req.body, 'name');
  if (!name || name.length > 100) return res.status(400).send(accountPage(req, { error: 'Please enter a name.' }));
  db.prepare('UPDATE users SET name = ?, notify = ? WHERE id = ?').run(name, Number(checked(req.body, 'notify')), req.user.id);
  req.user.name = name;
  req.user.notify = Number(checked(req.body, 'notify'));
  res.send(accountPage(req, { notice: 'Saved.' }));
});

router.post('/account/password', requireLogin, (req, res) => {
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.checkPassword(req.body.current, row.pass_hash)) return res.status(400).send(accountPage(req, { pwError: 'Your current password is incorrect.' }));
  const err = auth.validatePassword(req.body.password, req.body.confirm);
  if (err) return res.status(400).send(accountPage(req, { pwError: err }));
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), req.user.id);
  auth.endSessionsFor(req.user.id);
  auth.createSession(res, req.user.id, site.secureCookies());
  audit.log(req.user, 'Changed own password');
  res.send(accountPage(req, { pwNotice: 'Password changed. Other devices have been logged out.' }));
});

module.exports = { router, validateIdentity };
