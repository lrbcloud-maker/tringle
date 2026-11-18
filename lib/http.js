const auth = require('./auth');
const { layout } = require('./views');

const field = (body, key) => (body && typeof body[key] === 'string' ? body[key].trim() : '');
const checked = (body, key) => (body && body[key] ? '1' : '0');

// Only allow redirects to a path on this site (blocks "//evil.com" and "/\evil.com").
const safeNext = (n, fallback = '/equipment') => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && !/[\\\r\n]/.test(n) ? n : fallback);

function message(req, res, code, title, text) {
  res.status(code).send(layout({
    req,
    title,
    bare: !req.user,
    body: `<section class="panel narrow"><div class="panel-body"><h1>${title}</h1><p class="muted" style="margin-top:8px">${text}</p>
      ${req.user ? '<a class="btn" href="/equipment">Go to the register</a>' : ''}</div></section>`,
  }));
}

const notFound = (req, res) => message(req, res, 404, 'Not found', "This page or record doesn't exist. It may have been deleted.");
const forbidden = (req, res) => message(req, res, 403, 'No access', "Your account doesn't have permission to do that. Ask an admin if you need it.");

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (auth.userCount() === 0) return res.redirect('/setup');
  const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login${nextUrl}`);
}

const requirePerm = (perm) => (req, res, next) => requireLogin(req, res, () => (req.user.can(perm) ? next() : forbidden(req, res)));

// Where to send someone after login, given what they're allowed to see.
const homeFor = (user) => (user.can('equipment.view') ? '/equipment' : '/account');

module.exports = { field, checked, safeNext, notFound, forbidden, requireLogin, requirePerm, homeFor, message };
