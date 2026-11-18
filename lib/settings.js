const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR } = require('./db');

const DEFAULTS = {
  app_name: process.env.APP_NAME || 'Calibration Register',
  site_url: '',
  due_soon_days: '30',
  smtp_host: '',
  smtp_port: '587',
  smtp_security: 'starttls', // starttls | ssl | none
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  reminders_enabled: '0',
  reminder_days: '30,7,1',
  reminder_overdue: '1',
  reminder_hour: '8',
  reminder_recipients: '',
  reminder_contacts: '1',
  reminders_last_run: '',
  reminders_last_result: '',
};

const SECRET_KEYS = new Set(['smtp_pass']);

// Secrets (the SMTP password) are encrypted at rest with a key kept next to the database.
function loadKey() {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const [, iv, tag, enc] = blob.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return DEFAULTS[key] ?? '';
  return SECRET_KEYS.has(key) ? decrypt(row.value) : row.value;
}

function set(key, value) {
  const v = SECRET_KEYS.has(key) && value ? encrypt(String(value)) : String(value ?? '');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
}

const has = (key) => Boolean(db.prepare('SELECT 1 FROM settings WHERE key = ? AND value != ?').get(key, ''));
const num = (key) => Number(get(key)) || Number(DEFAULTS[key]) || 0;
const bool = (key) => get(key) === '1';

module.exports = { get, set, has, num, bool, DEFAULTS };
