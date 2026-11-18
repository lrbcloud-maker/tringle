const { db } = require('./db');
const settings = require('./settings');
const mailer = require('./mailer');
const audit = require('./audit');
const site = require('./site');
const { dueDate, todayStr, daysBetween, formatMonth, relative } = require('./dates');

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function parseDays(value) {
  const days = String(value || '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
  return [...new Set(days)].sort((a, b) => a - b);
}

function parseEmails(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s)))];
}

function globalRecipients() {
  const users = db.prepare('SELECT email FROM users WHERE notify = 1 AND disabled = 0 AND pass_hash IS NOT NULL').all().map((r) => r.email.toLowerCase());
  return [...new Set([...users, ...parseEmails(settings.get('reminder_recipients'))])];
}

// Which reminder (if any) each item is owed today. Uses "crossed a threshold and not yet sent for it",
// so a day when the app was switched off doesn't skip a reminder.
function pendingItems(today = todayStr()) {
  const thresholds = parseDays(settings.get('reminder_days'));
  const overdue = settings.bool('reminder_overdue');
  const sent = db.prepare('SELECT 1 FROM reminder_log WHERE equipment_id = ? AND due_date = ? AND threshold = ?');
  const out = [];
  for (const e of db.prepare('SELECT * FROM equipment ORDER BY cal_date').all()) {
    const due = dueDate(e.cal_date, e.cal_period);
    const left = daysBetween(today, due);
    let key = null;
    if (left < 0) key = overdue ? 'overdue' : null;
    else {
      const crossed = thresholds.filter((t) => left <= t);
      if (crossed.length) key = `d${Math.min(...crossed)}`;
    }
    if (key && !sent.get(e.id, due, key)) out.push({ ...e, due, left, key });
  }
  return out;
}

function buildEmail(items, today) {
  const base = site.baseUrl(null);
  const name = site.appName();
  const overdue = items.filter((i) => i.left < 0).length;
  const subject = overdue
    ? `${name}: ${overdue} overdue, ${items.length - overdue} due soon`
    : `${name}: ${items.length} item${items.length === 1 ? '' : 's'} due for calibration`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const when = (i) => (i.left < 0 ? `OVERDUE (${relative(i.due, today)})` : `due ${relative(i.due, today)}`);

  const text = [
    `The following equipment needs calibrating:`,
    '',
    ...items.map((i) => `- ${i.cert_no} | ${i.type} | S/N ${i.serial_no} | ${i.owner}, ${i.department} | due ${formatMonth(i.due)} (${when(i)})\n  ${base}/e/${i.public_id}`),
    '',
    `Sent automatically by ${name}.`,
  ].join('\n');

  const rows = items.map((i) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e3e1dc;font-family:Consolas,monospace"><a href="${esc(`${base}/e/${i.public_id}`)}" style="color:#1d4f73">${esc(i.cert_no)}</a></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e3e1dc">${esc(i.type)}<br><span style="color:#6b6760;font-size:12px">S/N ${esc(i.serial_no)}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e3e1dc">${esc(i.owner)}<br><span style="color:#6b6760;font-size:12px">${esc(i.department)}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e3e1dc;white-space:nowrap">${formatMonth(i.due)}<br><span style="font-size:12px;color:${i.left < 0 ? '#a8321f' : '#8a5a00'}">${esc(when(i))}</span></td>
    </tr>`).join('');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f4f1;font-family:Segoe UI,Arial,sans-serif;color:#1c1b19">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e1dc">
    <div style="padding:16px 20px;border-bottom:3px solid #1d4f73;font-weight:600">${esc(name)}</div>
    <div style="padding:20px">
      <p style="margin:0 0 14px">The following equipment needs calibrating:</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="text-align:left;color:#6b6760;font-size:12px;text-transform:uppercase">
          <th style="padding:6px 10px">Certificate</th><th style="padding:6px 10px">Equipment</th><th style="padding:6px 10px">Owner</th><th style="padding:6px 10px">Due</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:18px 0 0;color:#6b6760;font-size:12px">Sent automatically by ${esc(name)}. Reminder settings can be changed under Admin &rarr; Reminders.</p>
    </div>
  </div></body></html>`;
  return { subject, text, html };
}

async function run({ today = todayStr(), user = null } = {}) {
  const items = pendingItems(today);
  const result = { at: Date.now(), items: items.length, emails: 0, failures: [], unaddressed: 0 };
  if (!items.length) return save(result, 'Nothing was due, so no emails were sent.');

  const globals = globalRecipients();
  const useContacts = settings.bool('reminder_contacts');
  const byRecipient = new Map();
  const add = (email, item) => {
    if (!byRecipient.has(email)) byRecipient.set(email, []);
    const list = byRecipient.get(email);
    if (!list.includes(item)) list.push(item);
  };
  for (const item of items) {
    let any = false;
    for (const g of globals) { add(g, item); any = true; }
    const contact = (item.contact_email || '').trim().toLowerCase();
    if (useContacts && EMAIL_RE.test(contact)) { add(contact, item); any = true; }
    if (!any) result.unaddressed++;
  }

  const delivered = new Set();
  for (const [email, list] of byRecipient) {
    try {
      await mailer.send({ to: email, ...buildEmail(list, today) });
      result.emails++;
      list.forEach((i) => delivered.add(i));
    } catch (err) {
      result.failures.push(`${email}: ${mailer.describeError(err)}`);
    }
  }

  // Only mark an item as reminded once at least one email about it actually went out.
  const mark = db.prepare('INSERT OR IGNORE INTO reminder_log (equipment_id, due_date, threshold, sent_at) VALUES (?, ?, ?, ?)');
  for (const i of delivered) mark.run(i.id, i.due, i.key, Date.now());

  let msg = `Sent ${result.emails} email${result.emails === 1 ? '' : 's'} about ${delivered.size} item${delivered.size === 1 ? '' : 's'}.`;
  if (result.unaddressed) msg += ` ${result.unaddressed} item${result.unaddressed === 1 ? ' has' : 's have'} nobody to send to.`;
  if (result.failures.length) msg += ` ${result.failures.length} failed: ${result.failures.join(' | ')}`;
  audit.log(user, 'Reminders sent', msg);
  return save(result, msg);
}

function save(result, message) {
  result.message = message;
  settings.set('reminders_last_result', JSON.stringify(result));
  return result;
}

function lastResult() {
  try { return JSON.parse(settings.get('reminders_last_result') || 'null'); } catch { return null; }
}

// ---------- daily scheduler ----------
let running = false;
async function tick() {
  if (running) return;
  try {
    if (!settings.bool('reminders_enabled') || !mailer.smtpConfigured()) return;
    const today = todayStr();
    if (new Date().getHours() < settings.num('reminder_hour') && !process.env.FAKE_TODAY) return;
    if (settings.get('reminders_last_run') === today) return;
    running = true;
    settings.set('reminders_last_run', today);
    await run({ today });
  } catch (err) {
    console.error('Reminder run failed:', err);
  } finally {
    running = false;
  }
}

function startScheduler() {
  setTimeout(tick, 5000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = { run, pendingItems, globalRecipients, parseDays, parseEmails, lastResult, startScheduler, tick, EMAIL_RE };
