const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_DAYS = 7;
const LINK_DAYS = 7;
const MIN_PASSWORD = 8;

// ---------- roles & permissions ----------
const ROLES = {
  admin: { label: 'Admin', description: 'Everything, including users and settings. Cannot be restricted.' },
  editor: { label: 'Editor', description: 'Day-to-day register work.' },
  viewer: { label: 'Viewer', description: 'Look-up access.' },
};

const PERMISSIONS = {
  'equipment.view': 'View the equipment register, details and labels',
  'equipment.edit': 'Add equipment, edit records and record new calibrations',
  'equipment.delete': 'Delete equipment',
  'equipment.export': 'Export the register to CSV',
  'audit.view': 'See the activity log',
};
// Admin-only, never assignable to other roles.
const ADMIN_ONLY = ['users.manage', 'settings.manage'];

function permsFor(role) {
  if (role === 'admin') return new Set([...Object.keys(PERMISSIONS), ...ADMIN_ONLY]);
  return new Set(db.prepare('SELECT perm FROM role_permissions WHERE role = ?').all(role).map((r) => r.perm));
}

function setRolePerms(role, perms) {
  if (role === 'admin' || !ROLES[role]) return;
  const set = new Set(perms.filter((p) => PERMISSIONS[p]));
  // Editing, deleting or exporting is pointless without being able to see the register.
  if (['equipment.edit', 'equipment.delete', 'equipment.export'].some((p) => set.has(p))) set.add('equipment.view');
  db.prepare('DELETE FROM role_permissions WHERE role = ?').run(role);
  const ins = db.prepare('INSERT INTO role_permissions (role, perm) VALUES (?, ?)');
  for (const p of set) ins.run(role, p);
}

// ---------- passwords & tokens ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validatePassword(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords do not match.';
  return '';
}

// ---------- sessions ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

function createSession(res, userId, secure) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), userId);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

function destroySession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
  res.clearCookie('sid', { path: '/' });
}

const endSessionsFor = (userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

// Only users with a password who are not disabled can have a working session.
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const user = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.notify FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires > ? AND u.pass_hash IS NOT NULL AND u.disabled = 0
  `).get(sha256(sid), Date.now());
  if (!user) return null;
  user.perms = permsFor(user.role);
  user.can = (p) => user.perms.has(p);
  return user;
}

const userCount = () => db.prepare('SELECT COUNT(*) AS c FROM users WHERE pass_hash IS NOT NULL').get().c;
// Admins who can actually log in. There must always be at least one.
const workingAdminCount = () => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND pass_hash IS NOT NULL AND disabled = 0").get().c;
const isWorkingAdmin = (u) => u.role === 'admin' && u.pass_hash && !u.disabled;

function purgeExpired() {
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
}

// ---------- login throttling ----------
const attempts = new Map(); // key -> [timestamps]
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function throttleKey(req, email) { return `${req.ip}|${email}`; }
function isThrottled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= MAX_FAILS;
}
function recordFailure(key) { attempts.set(key, [...(attempts.get(key) || []), Date.now()]); }
function clearFailures(key) { attempts.delete(key); }

module.exports = {
  ROLES, PERMISSIONS, ADMIN_ONLY, permsFor, setRolePerms,
  hashPassword, checkPassword, randomToken, validatePassword,
  createSession, destroySession, endSessionsFor, currentUser,
  userCount, workingAdminCount, isWorkingAdmin, purgeExpired,
  throttleKey, isThrottled, recordFailure, clearFailures,
  LINK_DAYS, MIN_PASSWORD,
};
