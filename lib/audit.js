const { db } = require('./db');

function log(user, action, detail = '') {
  try {
    db.prepare('INSERT INTO audit_log (at, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), user ? user.id : null, user ? user.name : 'System', action, String(detail).slice(0, 500));
  } catch (err) {
    console.error('audit log failed', err);
  }
}

module.exports = { log };
