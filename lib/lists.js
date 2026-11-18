// Pick-lists for the dropdowns: types, owners, departments and manufacturers.
// Values are added automatically when an item is saved with a new one, and admins can manage them.
const { db, tx } = require('./db');

const KINDS = {
  type: { label: 'Types of equipment', one: 'type', column: 'type' },
  owner: { label: 'Owners', one: 'owner', column: 'owner' },
  department: { label: 'Departments', one: 'department', column: 'department' },
  manufacturer: { label: 'Manufacturers', one: 'manufacturer', column: 'manufacturer' },
};

// Free-text fields that also get a dropdown of values already used (not managed separately).
const USED_ONLY = ['calibrated_by', 'procedure'];

function values(kind) {
  if (KINDS[kind]) {
    return db.prepare('SELECT value FROM lists WHERE kind = ? ORDER BY value COLLATE NOCASE').all(kind).map((r) => r.value);
  }
  if (USED_ONLY.includes(kind)) {
    return db.prepare(`SELECT DISTINCT ${kind} AS v FROM equipment WHERE ${kind} != '' ORDER BY v COLLATE NOCASE LIMIT 500`).all().map((r) => r.v);
  }
  return [];
}

// Use the list's spelling when the same value is typed in a different case ("vernier" -> "Vernier").
function canonical(kind, value) {
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (!v || !KINDS[kind]) return v;
  const row = db.prepare('SELECT value FROM lists WHERE kind = ? AND value = ? COLLATE NOCASE').get(kind, v);
  return row ? row.value : v;
}

function remember(record) {
  const ins = db.prepare('INSERT OR IGNORE INTO lists (kind, value) VALUES (?, ?)');
  for (const kind of Object.keys(KINDS)) {
    const v = String(record[KINDS[kind].column] || '').trim();
    if (v) ins.run(kind, v);
  }
}

function usage(kind) {
  const col = KINDS[kind].column;
  const counts = Object.fromEntries(db.prepare(`SELECT ${col} AS v, COUNT(*) AS c FROM equipment GROUP BY ${col} COLLATE NOCASE`).all().map((r) => [r.v.toLowerCase(), r.c]));
  return values(kind).map((v) => ({ value: v, count: counts[v.toLowerCase()] || 0 }));
}

function add(kind, value) {
  return db.prepare('INSERT OR IGNORE INTO lists (kind, value) VALUES (?, ?)').run(kind, value).changes > 0;
}

// Renaming also updates every item that uses the old value (fixes typos everywhere at once).
function rename(kind, from, to) {
  const col = KINDS[kind].column;
  return tx(() => {
    const n = db.prepare(`UPDATE equipment SET ${col} = ?, updated_at = ? WHERE ${col} = ? COLLATE NOCASE`).run(to, Date.now(), from).changes;
    db.prepare('DELETE FROM lists WHERE kind = ? AND value = ?').run(kind, from);
    db.prepare('INSERT OR IGNORE INTO lists (kind, value) VALUES (?, ?)').run(kind, to);
    return n;
  });
}

function remove(kind, value) {
  const col = KINDS[kind].column;
  const used = db.prepare(`SELECT COUNT(*) c FROM equipment WHERE ${col} = ? COLLATE NOCASE`).get(value).c;
  if (used) return used;
  db.prepare('DELETE FROM lists WHERE kind = ? AND value = ?').run(kind, value);
  return 0;
}

module.exports = { KINDS, USED_ONLY, values, canonical, remember, usage, add, rename, remove };
