const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'calibration.db');
const DATA_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Each migration runs once, in order, inside a transaction. PRAGMA user_version records progress.
const MIGRATIONS = [
  // v1: the original schema (no-op on databases that already have it)
  `
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT,
    invite_token TEXT UNIQUE,
    invite_expires INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    cert_no TEXT NOT NULL,
    owner TEXT NOT NULL,
    department TEXT NOT NULL,
    type TEXT NOT NULL,
    serial_no TEXT NOT NULL,
    cal_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2: users with roles, permissions, settings, calibration history, reminders, activity log
  `
  ALTER TABLE admins RENAME TO users;
  ALTER TABLE sessions RENAME COLUMN admin_id TO user_id;
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login INTEGER;

  ALTER TABLE equipment ADD COLUMN contact_email TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN notes TEXT NOT NULL DEFAULT '';

  CREATE TABLE role_permissions (
    role TEXT NOT NULL,
    perm TEXT NOT NULL,
    PRIMARY KEY (role, perm)
  );
  INSERT INTO role_permissions (role, perm) VALUES
    ('editor', 'equipment.view'), ('editor', 'equipment.edit'), ('editor', 'equipment.export'),
    ('viewer', 'equipment.view');

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE calibration_history (
    id INTEGER PRIMARY KEY,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    cert_no TEXT NOT NULL,
    cal_date TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    recorded_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_history_equipment ON calibration_history(equipment_id);

  CREATE TABLE reminder_log (
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    threshold TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (equipment_id, due_date, threshold)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    user_id INTEGER,
    user_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_audit_at ON audit_log(at);
  `,
  // v3: calibration period in months (was always 1 year)
  `
  ALTER TABLE equipment ADD COLUMN cal_period INTEGER NOT NULL DEFAULT 12;
  ALTER TABLE calibration_history ADD COLUMN cal_period INTEGER NOT NULL DEFAULT 12;
  `,
  // v4: details from calibration reports (all optional)
  `
  ALTER TABLE equipment ADD COLUMN manufacturer TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN cal_range TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN calibrated_by TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN procedure TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN temperature TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN result TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN remarks TEXT NOT NULL DEFAULT '';
  ALTER TABLE equipment ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE equipment ADD COLUMN source_file TEXT NOT NULL DEFAULT '';
  ALTER TABLE calibration_history ADD COLUMN snapshot TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_equipment_serial ON equipment(serial_no COLLATE NOCASE);
  `,
  // v5: managed pick-lists (types, owners, departments, manufacturers), seeded from existing equipment
  `
  CREATE TABLE lists (
    kind TEXT NOT NULL,
    value TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (kind, value)
  );
  INSERT OR IGNORE INTO lists (kind, value) SELECT 'type', type FROM equipment WHERE type != '';
  INSERT OR IGNORE INTO lists (kind, value) SELECT 'owner', owner FROM equipment WHERE owner != '';
  INSERT OR IGNORE INTO lists (kind, value) SELECT 'department', department FROM equipment WHERE department != '';
  INSERT OR IGNORE INTO lists (kind, value) SELECT 'manufacturer', manufacturer FROM equipment WHERE manufacturer != '';
  `,
];

function migrate() {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database upgrade to version ${version + 1} failed: ${err.message}`);
    }
  }
}
migrate();

// Run a function inside a transaction. Nested calls join the outer transaction.
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    db.exec('COMMIT');
    return out;
  } catch (err) {
    txDepth--;
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, DB_PATH, DATA_DIR, tx };
