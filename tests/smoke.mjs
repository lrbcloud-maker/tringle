// End-to-end checks. Runs its own server on a throwaway database and a fake local mail server.
// Usage: npm test
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'calreg-test-'));
const PORT = 3199;
const B = `http://localhost:${PORT}`;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const pw = () => crypto.randomBytes(9).toString('base64url');

// ---------- fake SMTP server ----------
const mail = [];
let lastAuthPass = null;
const smtp = net.createServer((sock) => {
  let buf = '', inData = false, msg = null, authStep = null;
  const say = (s) => sock.write(`${s}\r\n`);
  say('220 test-smtp ready');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; mail.push(msg); say('250 queued'); } else msg.data += `${line}\n`;
        continue;
      }
      if (authStep === 'user') { authStep = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
      if (authStep === 'pass') { authStep = null; lastAuthPass = Buffer.from(line, 'base64').toString(); say('235 ok'); continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { sock.write('250-test-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
      else if (cmd === 'HELO') say('250 test-smtp');
      else if (cmd === 'AUTH') {
        const [, mech, arg] = line.split(' ');
        if (mech.toUpperCase() === 'PLAIN') {
          if (arg) { lastAuthPass = Buffer.from(arg, 'base64').toString().split('\0')[2]; say('235 ok'); } else { authStep = 'plain'; say('334 '); }
        } else { authStep = 'user'; say('334 VXNlcm5hbWU6'); }
      } else if (authStep === 'plain') { authStep = null; lastAuthPass = Buffer.from(line, 'base64').toString().split('\0')[2]; say('235 ok'); }
      else if (cmd === 'MAIL') { msg = { rcpt: [], data: '' }; say('250 ok'); }
      else if (cmd === 'RCPT') { msg.rcpt.push(line.match(/<([^>]+)>/)[1].toLowerCase()); say('250 ok'); }
      else if (cmd === 'DATA') { inData = true; say('354 go'); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else if (cmd === 'RSET' || cmd === 'NOOP') say('250 ok');
      else say('250 ok');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const SMTP_PORT = smtp.address().port;

// ---------- app server ----------
let server;
async function startServer(today, { scheduler = false } = {}) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(TMP, 'test.db'), FAKE_TODAY: today, NO_SCHEDULER: scheduler ? '0' : '1', BASE_URL: '', LAN_IP: '192.168.1.50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; process.stderr.write(d); });
  for (let i = 0; i < 50; i++) {
    if (log.includes('running')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
}

function client() {
  let cookie = '';
  return async (p, opts = {}) => {
    let body;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) for (const x of [].concat(v)) p.append(k, x);
      body = p.toString();
    }
    let multipart = false;
    if (opts.files) { // [{ name, buffer }] plus optional opts.fields
      body = new FormData();
      for (const [k, v] of Object.entries(opts.fields || {})) body.append(k, v);
      for (const f of opts.files) body.append('files', new Blob([f.buffer]), f.name);
      multipart = true;
    }
    const r = await fetch(B + p, {
      method: opts.form || multipart ? 'POST' : 'GET', redirect: 'manual', body,
      headers: { ...(body && !multipart ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { cookie } : {}), origin: B, ...(opts.headers || {}) },
    });
    for (const sc of r.headers.getSetCookie()) { const m = sc.match(/sid=([^;]*)/); if (m) cookie = m[1] ? `sid=${m[1]}` : ''; }
    return { status: r.status, loc: r.headers.get('location'), text: await r.text(), type: r.headers.get('content-type') || '' };
  };
}
// A calibration report laid out like the real template (merged cells, text date, tick boxes, formulas).
async function makeReport({ cert, serial, date, final = 'Fit For Use' }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1 (2)');
  const put = (range, v) => { if (range.includes(':')) ws.mergeCells(range); ws.getCell(range.split(':')[0]).value = v; };
  put('B2:V2', 'CALIBRATION REPORT'); put('B3:V3', 'WORKS INSTRUCTIONS'); put('B4:V4', 'WI-18-03'); put('B5:V5', 'Rev2;01-08-13');
  put('B8:H8', 'REPORT No.:'); put('J8:U8', cert);
  put('B11:H11', 'CALIBRATION OF:'); put('J11:N11', 'Vernier'); put('P11:Q11', 'Range'); put('R11:S11', 150); put('T11:U11', 'mm');
  put('B13:H13', 'MANUFACTURER:'); put('J13:U13', 'Insize');
  put('B15:H15', 'SERIAL NUMBER:'); put('J15:U15', serial);
  put('B17:I17', 'CALIBRATED BY:'); put('J17:U17', 'Test Tech');
  put('B19:I19', 'DATE OF CALIBRATION:'); put('J19:U19', date);
  put('B22:V22', 'DETAILS OF INSTRUMENTS USED DURING CALIBRATION');
  put('B23:I23', 'DESCRIPTION:'); put('J23:L23', 'MAKE:'); put('M23:O23', 'SERIAL NO:'); put('P23:V23', 'CERTIFICATE NUMBER:');
  put('B24:I24', 'SLIP GAUGES'); put('J24:L24', 'INSIZE'); put('M24:O24', '120043'); put('P24:V24', 'RW108877');
  put('B25:I25', 'SETTING RINGS - 8mm(7.999mm)'); put('J25:L25', 'INSIZE'); put('M25:O25', '0905140025'); put('P25:V25', '69458');
  put('B29:V29', 'RESULTS AT TIME OF CALIBRATION (Temperature: 19 - 21 ºC )');
  put('B30:E30', 'SPECIFIED SIZE (mm)'); put('F30', '% of Range'); put('G30:I30', 'MEASURED: (mm)'); put('J30:K30', 'ERRORS: (mm)'); put('M30:V30', 'ADJUSTMENTS:');
  put('B31:E31', 30); put('F31', 0.2); put('G31:I31', 30); put('J31:K31', { formula: 'B31-G31', result: 0 }); put('M31:V31', 'No');
  put('B32:E32', 60); put('F32', 0.4); put('G32:I32', 59.98); put('J32:K32', { formula: 'B32-G32' }); put('M32:V32', 'No');
  put('B39:K39', 'INTERNAL MEASURMENTS');
  put('B40:F40', '8mm(7.999mm)'); put('G40:I40', 7.98); put('J40:K40', { formula: '7.999-G40', result: 0.01899999999999924 }); put('M40:V40', 'No');
  put('B44:K44', 'FUNCTIONS TESTED:'); put('L44', true); put('M44:V44', 'REMARKS:');
  put('B45:K45', 'DIMENSIONAL INSPECTION'); put('L45', true); put('M45:V45', 'AS RECORDED ABOVE');
  put('B46:K46', 'CLEAN & VISUAL INSPECTION'); put('L46', false);
  put('B49:V49', `FINAL REMARKS: ${final}`);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const linkFrom = (text) => { const m = text.match(/id="link" readonly value="([^"]+)"/); return m && new URL(m[1].replace(/&amp;/g, '&')).pathname; };
const userIdByEmail = (text, email) => {
  const re = new RegExp(`href="/admin/users/(\\d+)">[^<]*</a>(?:[^<]|<(?!/td)[^>]*>)*?${email.replace('.', '\\.')}`);
  const m = text.match(re); return m && m[1];
};

try {
  await startServer('2026-11-18');
  const anon = client();
  const alice = client();
  const pAlice = pw();

  // ---------- setup & login ----------
  ok((await anon('/')).loc === '/setup', 'fresh install redirects to setup');
  let r = await alice('/setup', { form: { name: 'Alice', email: 'alice@example.com', password: pAlice, confirm: pAlice } });
  ok(r.status === 302 && r.loc === '/equipment', 'first admin created');
  ok((await anon('/setup')).loc === '/login', 'setup closed once someone exists');
  r = await client()('/login', { form: { email: 'alice@example.com', password: pAlice, next: '/\\evil.example' } });
  ok(r.loc === '/equipment', 'open redirect "/\\evil" blocked');

  // ---------- equipment ----------
  let serialN = 0;
  const add = (f) => alice('/equipment/new', { form: { owner: 'Bob', department: 'Lab', type: 'Torque wrench', serial_no: `SN-${++serialN}`, ...f } });
  r = await add({ cert_no: 'A-1', cal_date: '2025-11-05', contact_email: 'contact@example.com', notes: 'secret note' }); // 12 months -> due Nov 2026, valid to 30 Nov (12 days)
  const idA = r.loc.match(/equipment\/(\d+)/)[1];
  await add({ cert_no: 'B-2', cal_date: '2026-05-20', cal_period: '6', department: 'QA' }); // 6 months -> due Nov 2026
  await add({ cert_no: 'C-3', cal_date: '2024-02-29' }); // due Feb 2025 (valid to 28 Feb 2025), overdue
  await add({ cert_no: 'D-4', cal_date: '2026-06-01' }); // far away
  r = await add({ cert_no: '=HYPERLINK("x")', cal_date: '2026-01-05', type: '<script>x</script>' });
  ok(r.status === 302, 'tricky record created');
  ok((await add({ cert_no: 'X', cal_date: '2025-02-30' })).status === 400, 'invalid date rejected');
  ok((await add({ cert_no: 'X', cal_date: '2027-01-01' })).status === 400, 'future calibration date rejected');
  for (const bad of ['0', '121', '1.5', 'abc']) {
    ok((await add({ cert_no: 'X', cal_date: '2026-01-01', cal_period: bad })).status === 400, `calibration period "${bad}" rejected`);
  }
  r = await add({ cert_no: 'P-36', cal_date: '2026-01-31', cal_period: '36' });
  r = await anon(new URL((await alice(`${r.loc.split('?')[0]}`)).text.match(/Scanning opens <a class="mono" href="([^"]+)"/)[1]).pathname);
  ok(r.text.includes('<strong>Jan 2029</strong>') && r.text.includes('36 months (3 years)') && r.text.includes('valid to 31 Jan 2029'), '36-month period: due Jan 2029, valid to month end');
  r = await add({ cert_no: 'EOM', cal_date: '2025-10-31' }); // due Oct 2026 -> valid to 31 Oct, so overdue on 18 Nov
  ok((await alice('/equipment?status=overdue')).text.includes('EOM') && !(await alice('/equipment?status=overdue')).text.includes('>A-1<'), 'due month ends -> overdue; Nov item still in date');

  r = await alice(`/equipment/${idA}/label`);
  const scan = r.text.match(/Scanning opens <a class="mono" href="([^"]+)"/)[1];
  ok(scan.startsWith('http://192.168.1.50:3199/e/'), `trial QR uses LAN address (${scan})`);
  ok(r.text.includes('<svg') && r.text.includes('Trial address'), 'label shows QR and trial warning');
  const pubA = new URL(scan).pathname;
  r = await anon(pubA);
  ok(r.status === 200 && r.text.includes('<strong>Nov 2026</strong>') && r.text.includes('valid to 30 Nov 2026') && r.text.includes('A-1'), 'public page shows due as a month, valid to end of month');
  ok(!r.text.includes('secret note') && !r.text.includes('contact@example.com') && !r.text.includes('/equipment'), 'public page hides notes, contact and admin links');

  r = await alice('/equipment');
  ok(r.text.includes('&lt;script&gt;') && !r.text.includes('<script>x'), 'HTML escaped in register');
  ok((await alice('/equipment?q=torque')).text.includes('A-1'), 'search hit');
  ok((await alice('/equipment?q=%25')).text.includes('No matches'), 'search treats % literally');
  r = await alice('/equipment?department=QA');
  ok(r.text.includes('B-2') && !r.text.includes('A-1'), 'department filter');
  r = await alice('/equipment?status=overdue');
  ok(r.text.includes('C-3') && !r.text.includes('D-4'), 'status filter');

  r = await alice('/equipment/export.csv');
  ok(r.type.startsWith('text/csv') && r.text.includes(`"'=HYPERLINK(""x"")"`) && r.text.includes('2025-02-28'), 'CSV export with formula guard');

  r = await alice('/labels?ids=1&ids=2');
  ok((r.text.match(/class="label"/g) || []).length === 2, 'bulk label sheet');

  // edit: correction vs new calibration
  const base = { owner: 'Bob', department: 'Lab', type: 'Torque wrench', serial_no: 'SN', contact_email: 'contact@example.com' };
  r = await alice(`/equipment/${idA}/edit`, { form: { ...base, cert_no: 'A-1b', cal_date: '2025-11-05' } });
  ok(r.loc === `${pubA}?saved=1`, 'edit keeps the same QR link');
  ok(!(await anon(pubA)).text.includes('Previous calibrations'), 'correction without tick adds no history');
  await alice(`/equipment/${idA}/edit`, { form: { ...base, cert_no: 'A-1', cal_date: '2025-11-05' } });

  // ---------- "in N months" wording ----------
  r = await anon(pubA);
  ok(r.text.includes('in 12 days'), 'under a month away shows days');
  const p36 = (await alice('/equipment?q=P-36')).text.match(/href="(\/e\/[\w-]+)"/)[1];
  ok((await anon(p36)).text.includes('in 26 months'), 'over a month away shows whole months (rounded down)');
  ok((await alice('/equipment?status=overdue')).text.includes('20 months ago'), 'overdue shows months ago');

  // ---------- new calibration fields, "not fit for use" ----------
  r = await add({ cert_no: 'U-9', serial_no: 'UNFIT-1', cal_date: '2026-10-01', manufacturer: 'Mitutoyo', cal_range: '0–25 mm', calibrated_by: 'Jo Bloggs', procedure: 'WI-9', temperature: '20 °C', result: 'unfit', remarks: 'Jaw damaged',
    'instruments.description': ['Gauge block'], 'instruments.make': ['Mitutoyo'], 'instruments.serial': ['007'], 'instruments.cert': ['GB-1'],
    'readings.section': ['', ''], 'readings.nominal': ['10', '20'], 'readings.measured': ['10.01', '20.2'], 'readings.error': ['-0.01', '-0.2'], 'readings.adjusted': ['No', 'No'],
    'checks.name': ['Visual'], 'checks.done': ['No'] });
  const pubU = (await alice(r.loc.split('?')[0])).text.match(/Scanning opens <a class="mono" href="[^"]*?(\/e\/[\w-]+)"/)[1];
  r = await anon(pubU);
  ok(r.text.includes('Not fit for use. Do not use') && r.text.includes('Mitutoyo') && r.text.includes('0–25 mm') && r.text.includes('Jo Bloggs') && r.text.includes('WI-9'), 'new fields shown; unfit overrides in-date');
  ok(r.text.includes('Reference instruments') && r.text.includes('GB-1') && r.text.includes('20.2') && r.text.includes('Checks performed'), 'readings, instruments and checks shown on scan page');
  ok((await alice('/equipment?status=unfit')).text.includes('U-9'), 'status filter: not fit for use');

  // ---------- readings: apparatus, adjusted dropdown, calculated error ----------
  r = await add({ cert_no: 'R-1', cal_date: '2026-09-01', 'instruments.description': ['Setting ring 8mm'], 'instruments.make': [''], 'instruments.serial': [''], 'instruments.cert': [''],
    'readings.section': ['Setting ring 8mm', 'Slip gauges', 'Visual'], 'readings.nominal': ['8mm(7.999mm)', '25mm(24,997mm)', 'n/a'], 'readings.measured': ['7.98', '24.98', 'ok'],
    'readings.error': ['WRONG', '', 'within tol'], 'readings.adjusted': ['', 'Yes', 'N/A'] });
  const r1Id = r.loc.match(/equipment\/(\d+)/)[1];
  r = await alice(`/equipment/${r1Id}/edit`);
  ok(/value="0\.019"[^>]*readonly/.test(r.text) && /value="0\.017"[^>]*readonly/.test(r.text), 'error calculated (specified − measured, 3 dp) even if typed wrongly, decimal comma handled');
  ok(/value="within tol"(?![^>]*readonly)/.test(r.text), 'error stays editable when sizes aren\'t numbers');
  ok((r.text.match(/<option>Yes<\/option><option>No<\/option><option selected>N\/A<\/option>/g) || []).length >= 2 && r.text.includes('<option selected>Yes</option><option>No</option><option>N/A</option>'), 'adjusted is a Yes / No / N/A dropdown (blank becomes N/A)');
  ok(r.text.includes('<th>Apparatus</th>') && r.text.includes('data-options-from="instruments.description"') && r.text.includes('"Setting ring 8mm"'), 'readings column is "Apparatus", offering the reference instruments');
  r = await anon((await alice(`/equipment/${r1Id}/label`)).text.match(/Scanning opens <a class="mono" href="[^"]*?(\/e\/[\w-]+)"/)[1]);
  ok(r.text.includes('<th>Apparatus</th>') && r.text.includes('0.019') && r.text.includes('0.017'), 'scan page shows Apparatus and calculated errors');

  // ---------- pick-or-add dropdowns and Admin → Lists ----------
  r = await alice('/equipment/new');
  const optsOf = (html, name) => JSON.parse((html.match(new RegExp(`name="${name}"[\\s\\S]*?data-combo-options>([^<]*)</script>`)) || [, '[]'])[1]);
  ok(optsOf(r.text, 'type').includes('Torque wrench') && optsOf(r.text, 'department').includes('QA') && optsOf(r.text, 'owner').includes('Bob'), 'type, owner and department dropdowns list the values already used');
  ok(!r.text.includes('<datalist'), 'old browser suggestion lists removed');
  await add({ cert_no: 'L-1', cal_date: '2026-09-01', type: 'Laser level', department: 'Survey' });
  r = await alice('/equipment/new');
  ok(optsOf(r.text, 'type').includes('Laser level') && optsOf(r.text, 'department').includes('Survey'), 'a new type typed on the form is added to the dropdown');
  await add({ cert_no: 'L-2', cal_date: '2026-09-01', type: 'LASER LEVEL', department: 'survey' });
  r = await alice('/equipment/new');
  ok(optsOf(r.text, 'type').filter((t) => t.toLowerCase() === 'laser level').length === 1 && (await alice('/equipment?type=Laser+level')).text.includes('>L-2<'), 'different letter case saves with the existing spelling');
  r = await alice('/admin/lists/type/add', { form: { value: 'Thermometer' } });
  ok(r.status === 200 && r.text.includes('Added &quot;Thermometer&quot;'), 'admin can add a type');
  ok(optsOf((await alice('/equipment/new')).text, 'type').includes('Thermometer'), 'added type shows in the dropdown before any item uses it');
  r = await alice('/admin/lists/type/rename', { form: { from: 'Laser level', to: 'Laser Level (rotary)' } });
  ok(r.text.includes('updated 2 items') && (await alice('/equipment?type=Laser+Level+%28rotary%29')).text.includes('>L-1<'), 'renaming a type updates the items using it');
  r = await alice('/admin/lists/type/remove', { form: { value: 'Laser Level (rotary)' } });
  ok(r.status === 400 && r.text.includes('used by 2 items'), 'a type in use can\'t be removed');
  r = await alice('/admin/lists/type/remove', { form: { value: 'Thermometer' } });
  ok(r.status === 200 && !optsOf((await alice('/equipment/new')).text, 'type').includes('Thermometer'), 'an unused type can be removed');
  ok((await alice('/admin/lists/nonsense/add', { form: { value: 'x' } })).status === 404, 'unknown list rejected');
  r = await add({ cert_no: 'DUP', serial_no: 'unfit-1', cal_date: '2026-10-01' });
  ok(r.status === 409 && r.text.includes('already in the register'), 'duplicate serial warned (case-insensitive)');
  r = await add({ cert_no: 'DUP', serial_no: 'unfit-1', cal_date: '2026-10-01', allow_duplicate: '1' });
  ok(r.status === 302, 'duplicate serial allowed after confirming');
  await alice(`${r.loc.match(/\/equipment\/\d+/)[0]}/delete`, { form: {} });

  // ---------- filtering by every field ----------
  const has = async (qsx, yes, no) => { const t = (await alice(`/equipment?${qsx}`)).text; return yes.every((c) => t.includes(`>${c}<`)) && no.every((c) => !t.includes(`>${c}<`)); };
  ok(await has('manufacturer=Mitutoyo', ['U-9'], ['A-1']), 'filter: manufacturer');
  ok(await has('calibrated_by=Jo+Bloggs', ['U-9'], ['A-1']), 'filter: calibrated by');
  ok(await has('result=unfit', ['U-9'], ['A-1']), 'filter: result');
  ok(await has('result=none', ['A-1'], ['U-9']), 'filter: result not recorded');
  ok(await has('cal_period=6', ['B-2'], ['A-1']), 'filter: calibration period');
  ok(await has('department=QA', ['B-2'], ['A-1']), 'filter: department');
  ok(await has('cert_no=P-3', ['P-36'], ['A-1']), 'filter: certificate contains');
  ok(await has('serial_no=unfit', ['U-9'], ['A-1']), 'filter: serial contains');
  ok(await has('cal_range=25', ['U-9'], ['A-1']), 'filter: range contains');
  ok(await has('remarks=jaw', ['U-9'], ['A-1']), 'filter: remarks contains');
  ok(await has('cal_from=2026-05-01&cal_to=2026-05-31', ['B-2'], ['A-1', 'U-9']), 'filter: calibrated date range');
  ok(await has('due_from=2029-01&due_to=2029-01', ['P-36'], ['A-1']), 'filter: due month range');
  ok(await has('q=Bloggs', ['U-9'], ['A-1']), 'search covers the new fields');
  r = await alice('/equipment/export.csv?manufacturer=Mitutoyo');
  ok(r.text.includes('U-9') && !r.text.includes('A-1') && r.text.includes('Gauge block S/N 007 cert GB-1'), 'CSV export honours filters and includes new columns');

  // ---------- Excel import ----------
  const rep1 = await makeReport({ cert: 'PG002_01', serial: 'SC3570225210836', date: '02/11/2026' });
  r = await alice('/equipment/import', { files: [{ name: 'Vernier PG002_01.xlsx', buffer: rep1 }] });
  ok(r.status === 200 && r.text.includes('value="PG002_01"') && r.text.includes('value="SC3570225210836"') && r.text.includes('value="Insize"') && r.text.includes('value="150 mm"'), 'import: one file fills in the form');
  ok(r.text.includes('value="2026-11-02"') && r.text.includes('read as 2 Nov 2026 (day/month/year)'), 'import: dd/mm/yyyy date read day-first and flagged');
  ok(r.text.includes('value="WI-18-03 Rev2; 01-08-13"') && r.text.includes('value="Test Tech"') && r.text.includes('value="19–21 °C"') && r.text.includes('<option value="fit" selected'), 'import: procedure, technician, temperature, result');
  ok(r.text.includes('value="0905140025"') && r.text.includes('value="0.02"') && r.text.includes('value="0.019"') && r.text.includes('Internal measurments'), 'import: instruments (leading zero kept), readings (missing error computed), sections');
  ok(r.text.includes('please fill in: owner, department'), 'import: says what is missing');
  ok(r.text.includes('>As recorded above</textarea>') && r.text.includes('value="Clean &amp; visual inspection"') && /value="Clean &amp; visual inspection"[\s\S]{0,400}<option selected>No/.test(r.text), 'import: remarks and checks (unticked box = No)');
  const importForm = {
    cert_no: 'PG002_01', serial_no: 'SC3570225210836', type: 'Vernier', manufacturer: 'Insize', cal_range: '150 mm', owner: 'Travis', department: 'Workshop',
    cal_date: '2026-11-02', cal_period: '12', result: 'fit', calibrated_by: 'Test Tech', procedure: 'WI-18-03 Rev2; 01-08-13', source_file: 'Vernier PG002_01.xlsx',
    'instruments.description': ['Slip gauges'], 'instruments.make': ['INSIZE'], 'instruments.serial': ['120043'], 'instruments.cert': ['RW108877'],
  };
  r = await alice('/equipment/new', { form: importForm });
  ok(r.status === 302, 'import: saved after review');
  const pgId = r.loc.match(/equipment\/(\d+)/)[1];
  r = await alice('/equipment/import', { files: [{ name: 'Vernier PG002_01.xlsx', buffer: rep1 }] });
  ok(r.text.includes('is already recorded'), 'import: same report again is recognised, not duplicated');
  const rep2 = await makeReport({ cert: 'PG002_02', serial: 'SC3570225210836', date: '10/11/2026', final: 'Not fit for use' });
  r = await alice('/equipment/import', { files: [{ name: 'Vernier PG002_02.xlsx', buffer: rep2 }] });
  ok(r.text.includes(`action="/equipment/${pgId}/recalibrate"`) && r.text.includes('already in the register') && r.text.includes('value="Travis"') && r.text.includes('<option value="unfit" selected'), 'import: same serial becomes a new calibration, keeps owner');
  r = await alice(`/equipment/${pgId}/recalibrate`, { form: { ...importForm, cert_no: 'PG002_02', cal_date: '2026-11-10', result: 'unfit', calibrated_by: 'Other Tech' } });
  ok(r.status === 302, 'import: new calibration saved');
  r = await alice(r.loc);
  ok(r.text.includes('Not fit for use. Do not use') && /PG002_01<\/td><td[^>]*>2 Nov 2025|PG002_01<\/td><td[^>]*>2 Nov 2026/.test(r.text) && r.text.includes('Fit for use</td><td class="hide-sm">Test Tech'), 'history keeps the old certificate with its own result and technician');
  // several files at once -> review table
  const rep3 = await makeReport({ cert: 'MC100_01', serial: 'MC-100', date: '01/10/2026' });
  const bad = Buffer.from('not a spreadsheet');
  r = await alice('/equipment/import', { files: [{ name: 'a.xlsx', buffer: rep3 }, { name: 'b.xlsx', buffer: rep1 }, { name: 'c.xlsx', buffer: bad }, { name: 'notes.txt', buffer: bad }] });
  ok(r.text.includes('Review 2 reports') && r.text.includes('Add as new item') && r.text.includes('Already in PG002_02') && r.text.includes('c.xlsx: couldn') && r.text.includes('notes.txt: not an .xlsx'), 'import: several files go to a review table with a plan per row');
  const dataFields = {};
  for (const m of r.text.matchAll(/name="(data_\d|note_\d|cal_date_\d|owner_\d|department_\d|cal_period_\d|count)" value="([^"]*)"/g)) dataFields[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  r = await alice('/equipment/import/confirm', { form: { ...dataFields, inc_0: '1', inc_1: '1' } });
  ok(r.status === 400 && r.text.includes('Please fill in: owner, department'), 'import review: missing owner/department caught');
  r = await alice('/equipment/import/confirm', { form: { ...dataFields, inc_0: '1', inc_1: '1', default_owner: 'Stores', default_department: 'Lab' } });
  ok(r.status === 302 && decodeURIComponent(r.loc).includes('1 new item') && decodeURIComponent(r.loc).includes('1 already recorded'), 'import review: defaults applied, duplicates skipped');
  ok((await alice('/equipment?serial_no=MC-100')).text.includes('MC100_01'), 'import review: new item created');
  ok((await alice('/equipment?serial_no=SC357')).text.match(/cell-link mono/g).length === 1, 'import review: no duplicate item for the same serial');
  // bulk: a newer report for an existing item + an older report -> keeps the item's own details
  const mcId = (await alice('/equipment?serial_no=MC-100')).text.match(/\/equipment\/(\d+)\/edit/)[1];
  await alice(`/equipment/${mcId}/edit`, { form: { cert_no: 'MC100_01', serial_no: 'MC-100', type: 'Vernier', owner: 'Stores', department: 'Lab', cal_date: '2026-10-01', cal_period: '24', manufacturer: 'Insize', cal_range: '150 mm' } });
  const rep4 = await makeReport({ cert: 'MC100_02', serial: 'MC-100', date: '05/11/2026' });
  const rep0 = await makeReport({ cert: 'PG002_00', serial: 'SC3570225210836', date: '01/11/2025' });
  r = await alice('/equipment/import', { files: [{ name: 'mc2.xlsx', buffer: rep4 }, { name: 'pg0.xlsx', buffer: rep0 }] });
  ok(r.text.includes('New calibration for MC100_01') && r.text.includes('Older than PG002_02') && r.text.includes('value="Stores"') && r.text.includes('value="24"'), 'bulk review: matched rows start from the existing item');
  const df2 = {};
  for (const m of r.text.matchAll(/name="(data_\d|note_\d|cal_date_\d|owner_\d|department_\d|cal_period_\d|count)" value="([^"]*)"/g)) df2[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  r = await alice('/equipment/import/confirm', { form: { ...df2, inc_0: '1', inc_1: '1' } });
  ok(r.status === 302 && decodeURIComponent(r.loc).includes('1 new calibration') && decodeURIComponent(r.loc).includes('1 older report'), 'bulk confirm: new calibration + older report saved');
  r = await alice(`/e/${(await alice('/equipment?serial_no=MC-100')).text.match(/href="\/e\/([\w-]+)"/)[1]}`);
  ok(r.text.includes('MC100_02') && r.text.includes('Stores') && r.text.includes('24 months (2 years)') && /MC100_01<\/td>/.test(r.text), 'bulk confirm: item keeps owner, department and period; old cert in history');
  r = await alice(`/e/${(await alice('/equipment?serial_no=SC357')).text.match(/href="\/e\/([\w-]+)"/)[1]}`);
  ok(r.text.includes('Not fit for use. Do not use') && r.text.includes('class="eyebrow">PG002_02<') && /PG002_00<\/td>/.test(r.text), 'older report went to history, current calibration unchanged');
  r = await alice('/equipment/import', { files: [{ name: 'old.xlsx', buffer: rep1 }] });
  ok(r.text.includes('already recorded') && r.text.includes('Nothing was changed'), 'single upload of a superseded report: recognised, nothing changed');
  r = await alice('/equipment/import', { files: [{ name: 'pg0.xlsx', buffer: rep0 }] });
  ok(r.text.includes('Already in PG002_02') || r.text.includes('already recorded'), 'single upload of an older report already in history: recognised');

  ok(await has('owner=Travis', ['PG002_02'], ['A-1', 'MC100_01']), 'filter: owner');
  ok(await has('type=Vernier&department=Lab', ['MC100_02'], ['PG002_02', 'A-1']), 'filter: type + department combined');

  // ---------- register grouped by department, then owner ----------
  r = await alice('/equipment');
  const deptNames = [...r.text.matchAll(/grp-dept"[\s\S]*?class="grp-name">([^<]*)</g)].map((m) => m[1]);
  const sortedCI = (arr) => arr.every((v, i) => i === 0 || arr[i - 1].localeCompare(v, undefined, { sensitivity: 'base' }) <= 0);
  ok(deptNames.length >= 3 && sortedCI(deptNames) && deptNames.includes('QA') && deptNames.includes('Lab'), `register grouped by department, A–Z (${deptNames.join(', ')})`);
  ok(r.text.includes('grp-owner') && /grp-owner[\s\S]*?class="grp-name">Bob</.test(r.text) && !r.text.includes('<th class="hide-sm">Owner</th>'), 'owners grouped under each department');
  const labBlock = r.text.split('class="grp-name">Lab<')[1].split('grp-dept')[0];
  ok(labBlock.includes('>A-1<') && !labBlock.includes('>B-2<'), 'items sit under their own department');
  ok(/data-select-group="d0"/.test(r.text) && /data-in="d0 d0o0"/.test(r.text), 'group tick boxes and collapsible rows present');
  r = await alice('/equipment?view=list');
  ok(!r.text.includes('grp-dept') && r.text.includes('<th class="hide-sm">Owner</th>') && r.text.includes('name="view" value="list"'), 'single-list view still available and remembered by the filters');
  ok(r.text.includes('href="/equipment?status=overdue&view=list"'), 'status tiles keep the chosen view');
  r = await alice('/equipment/export.csv');
  const csvDepts = r.text.trim().split('\r\n').slice(1).map((line) => line.match(/^(?:"[^"]*"|[^,]*),(?:"[^"]*"|[^,]*),("[^"]*"|[^,]*)/)[1].replace(/"/g, ''));
  ok(sortedCI(csvDepts), 'CSV export follows the grouped order');
  ok((await alice('/equipment?department=QA')).text.includes('class="grp-name">QA<') && !(await alice('/equipment?department=QA')).text.includes('class="grp-name">Lab<'), 'grouping works with filters');

  // ---------- SharePoint / document link ----------
  const pgItem = (await alice('/equipment?serial_no=SC357&view=list')).text;
  const pgPub = pgItem.match(/href="(\/e\/[\w-]+)"/)[1];
  const pgEdit = await alice(`/equipment/${pgId}/edit`);
  const formVals = {};
  for (const m of pgEdit.text.matchAll(/<input type="(?:text|date|number|email|url)"[^>]*name="([a-z_]+)"[^>]*value="([^"]*)"/g)) formVals[m[1]] = m[2].replace(/&amp;/g, '&');
  for (const m of pgEdit.text.matchAll(/<input[^>]*name="([a-z_]+)"[^>]*role="combobox"/g)) formVals[m[1]] = formVals[m[1]] ?? '';
  for (const m of pgEdit.text.matchAll(/id="([a-z_]+)" name="\1" value="([^"]*)"[^>]*role="combobox"/g)) formVals[m[1]] = m[2].replace(/&amp;/g, '&');
  r = await alice(`/equipment/${pgId}/edit`, { form: { ...formVals, doc_link: 'javascript:alert(1)' } });
  ok(r.status === 400 && r.text.includes('must be a web address'), 'document link must be a web address (javascript: rejected)');
  const spLink = `https://contoso.sharepoint.com/sites/Quality/Shared%20Documents/Calibration/PG002?${'x'.repeat(400)}&web=1`;
  r = await alice(`/equipment/${pgId}/edit`, { form: { ...formVals, doc_link: spLink } });
  ok(r.status === 302, 'long SharePoint link saved');
  r = await alice(pgPub);
  ok(r.text.includes(`href="${spLink.replace(/&/g, '&amp;')}"`) && r.text.includes('Open documents (SharePoint)') && r.text.includes('rel="noopener noreferrer"'), 'logged-in page shows "Open documents" link');
  ok(!(await anon(pgPub)).text.includes('sharepoint.com'), 'public scan page does not show the document link');
  ok((await alice(`/equipment/${pgId}/recalibrate`)).text.includes('contoso.sharepoint.com'), 'record new calibration keeps the document link');
  ok((await alice('/equipment/export.csv?serial_no=SC357')).text.includes('contoso.sharepoint.com'), 'document link in CSV export');
  const rep3b = await makeReport({ cert: 'PG002_03', serial: 'SC3570225210836', date: '15/11/2026' });
  const rep5 = await makeReport({ cert: 'NEW_01', serial: 'NEW-1', date: '15/11/2026' });
  r = await alice('/equipment/import', { files: [{ name: 'pg3.xlsx', buffer: rep3b }, { name: 'n.xlsx', buffer: rep5 }] });
  const df3 = {};
  for (const m of r.text.matchAll(/name="(data_\d|note_\d|cal_date_\d|owner_\d|department_\d|cal_period_\d|count)" value="([^"]*)"/g)) df3[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  r = await alice('/equipment/import/confirm', { form: { ...df3, inc_0: '1', inc_1: '1', default_owner: 'X', default_department: 'Lab' } });
  ok(r.status === 302 && (await alice(pgPub)).text.includes('contoso.sharepoint.com') && (await alice(pgPub)).text.includes('class="eyebrow">PG002_03<'), 'Excel import of a new calibration keeps the document link');

  // ---------- PDF export ----------
  const pdfRes = await fetch(`${B}${pgPub}/pdf`);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  ok(pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && pdfBuf.subarray(0, 5).toString() === '%PDF-' && pdfBuf.length > 5000, 'PDF downloads for anyone with the QR link (same as the page)');
  ok(/attachment; filename="PG002_03 Vernier\.pdf"/.test(pdfRes.headers.get('content-disposition') || ''), 'PDF has a sensible file name');
  ok((await anon(pgPub)).text.includes(`href="${pgPub}/pdf"`) && (await alice(pgPub)).text.includes('Download PDF'), 'PDF links on the public and logged-in pages');
  ok((await fetch(`${B}/e/doesnotexist/pdf`)).status === 404, 'PDF for an unknown item is 404');

  // ---------- editable QR sticker layout ----------
  r = await alice(`/equipment/${pgId}/label`);
  ok(r.text.includes('data-label-editor') && r.text.includes('--lw:90mm;--lh:46mm') && /data-lf="cert_no">/.test(r.text) && /data-lf="owner" hidden/.test(r.text), 'label page has the layout editor with the standard layout');
  r = await alice('/labels/layout', { form: { size: '62x29', text: 'small', title: '', extra: 'Do not use after the due date', fields: ['cert_no', 'due', 'owner'], back: `/equipment/${pgId}/label?new=1` } });
  ok(r.status === 302 && r.loc === `/equipment/${pgId}/label?layout=saved`, 'layout saved, back to the same label');
  r = await alice(r.loc);
  ok(r.text.includes('Sticker layout saved') && r.text.includes('--lw:62mm;--lh:29mm;--lfs:7pt') && /data-lf="owner">/.test(r.text) && /data-lf="serial_no" hidden/.test(r.text), 'saved size, text size and chosen details applied');
  ok(/data-label-title[^>]*hidden/.test(r.text) && r.text.includes('>Do not use after the due date<'), 'title switched off, extra line shown');
  ok(/data-lf="due" class="label-due"><span class="k">Due<\/span> <span class="v">Nov 2027</.test(r.text), 'due date still comes from the record');
  r = await alice(`/labels?ids=${pgId}&ids=${mcId}`);
  ok(r.text.includes('--lw:62mm') && (r.text.match(/class="label"/g) || []).length === 2, 'bulk label sheet uses the same saved layout');
  r = await alice('/labels/layout', { form: { size: 'custom', w: '500', h: '5', text: 'huge', fields: ['nonsense'], back: '//evil.example' } });
  ok(r.loc === '/equipment?layout=saved', 'unsafe "back" address ignored');
  ok((await alice(`/equipment/${pgId}/label`)).text.includes('--lw:150mm;--lh:20mm;--lfs:8.5pt'), 'custom sizes clamped to sensible limits');
  r = await alice('/labels/layout', { form: { reset: '1', back: `/equipment/${pgId}/label` } });
  ok((await alice(`/equipment/${pgId}/label`)).text.includes('--lw:90mm;--lh:46mm'), 'reset returns to the standard sticker');

  // ---------- email settings ----------
  const smtpPass = pw();
  r = await alice('/admin/email', { form: { smtp_host: '127.0.0.1', smtp_port: String(SMTP_PORT), smtp_security: 'none', smtp_user: 'mailer', smtp_pass: smtpPass, smtp_from: 'Register <reg@example.com>' } });
  ok(r.status === 200 && !r.text.includes(smtpPass), 'SMTP saved, password not shown back');
  await alice('/admin/email', { form: { smtp_host: '127.0.0.1', smtp_port: String(SMTP_PORT), smtp_security: 'none', smtp_user: 'mailer', smtp_pass: '', smtp_from: 'Register <reg@example.com>' } });
  r = await alice('/admin/email/test', { form: { to: 'alice@example.com' } });
  ok(r.status === 200 && mail.length === 1 && mail[0].rcpt[0] === 'alice@example.com', 'test email delivered');
  ok(lastAuthPass === smtpPass, 'blank password field kept the saved password');
  const dbFile = fs.readFileSync(path.join(TMP, 'test.db')).toString('latin1') + (fs.existsSync(path.join(TMP, 'test.db-wal')) ? fs.readFileSync(path.join(TMP, 'test.db-wal')).toString('latin1') : '');
  ok(!dbFile.includes(smtpPass), 'SMTP password encrypted in database');

  // ---------- reminders ----------
  await alice('/admin/reminders', { form: { reminders_enabled: '1', reminder_days: '30, 7, 1', reminder_hour: '8', reminder_recipients: 'qa@example.com', reminder_overdue: '1', reminder_contacts: '1' } });
  mail.length = 0;
  r = await alice('/admin/reminders/run', { form: {} });
  const to = (e) => mail.find((m) => m.rcpt.includes(e));
  ok(mail.length === 3, `reminders: 3 emails sent (${mail.length})`);
  const aliceMail = to('alice@example.com');
  ok(aliceMail && ['A-1', 'B-2', 'C-3'].every((c) => aliceMail.data.includes(c)) && !aliceMail.data.includes('D-4'), 'admin digest has A, B, C but not D');
  ok(to('qa@example.com'), 'extra recipient got the digest');
  const contactMail = to('contact@example.com');
  ok(contactMail && contactMail.data.includes('A-1') && !contactMail.data.includes('B-2'), 'contact only gets their own item');
  mail.length = 0;
  r = await alice('/admin/reminders/run', { form: {} });
  ok(mail.length === 0 && r.text.includes('Nothing was due'), 'second run sends nothing (no duplicates)');

  // ---------- users & permissions ----------
  const invite = async (name, email, role) => {
    const res = await alice('/admin/users', { form: { name, email, role } });
    const page = await alice(res.loc);
    return { id: res.loc.match(/users\/(\d+)/)[1], link: linkFrom(page.text) };
  };
  const bobInv = await invite('Bob', 'bob@example.com', 'viewer');
  const carolInv = await invite('Carol', 'carol@example.com', 'editor');
  ok(bobInv.link && carolInv.link, 'invite links created');
  const bob = client(), carol = client();
  const pBob = pw(), pCarol = pw();
  ok((await bob(bobInv.link, { form: { password: pBob, confirm: pBob } })).loc === '/equipment', 'viewer accepted invite');
  ok((await carol(carolInv.link, { form: { password: pCarol, confirm: pCarol } })).loc === '/equipment', 'editor accepted invite');
  ok((await bob(bobInv.link)).status === 404, 'invite link is single-use');
  mail.length = 0;
  await alice('/admin/users', { form: { name: 'Dave', email: 'dave@example.com', role: 'viewer', send_email: '1' } });
  const daveMail = mail.find((m) => m.rcpt.includes('dave@example.com'));
  ok(daveMail && /\/invite\/[\w-]+/.test(daveMail.data.replace(/=\r?\n/g, '')), 'invite link emailed to new user');

  ok((await bob('/equipment')).status === 200, 'viewer: can see register');
  ok((await bob('/equipment/new')).status === 403, 'viewer: cannot open add form');
  r = await bob('/equipment/new', { form: { cert_no: 'HACK', owner: 'x', department: 'x', type: 'x', serial_no: 'x', cal_date: '2026-01-01' } });
  ok(r.status === 403 && !(await alice('/equipment')).text.includes('HACK'), 'viewer: cannot add by posting');
  ok((await bob('/equipment/export.csv')).status === 403, 'viewer: no CSV by default');
  ok((await bob('/admin/users')).status === 403, 'viewer: no admin');
  ok((await bob('/equipment/import', { files: [{ name: 'x.xlsx', buffer: await makeReport({ cert: 'V-1', serial: 'V-1', date: '01/01/2026' }) }] })).status === 403, 'viewer: cannot import');
  ok((await bob('/admin/lists')).status === 403 && (await bob('/admin/lists/type/add', { form: { value: 'Hack' } })).status === 403, 'viewer: cannot manage lists');
  ok((await bob('/labels/layout', { form: { size: '50x30' } })).status === 403, 'viewer: cannot change the saved sticker layout');
  r = await bob(`/equipment/${idA}/label`);
  ok(r.status === 200 && r.text.includes('data-label-editor') && r.text.includes('Only editors can save') && !r.text.includes('Save as default'), 'viewer: can preview layout changes but not save them');
  ok(!(await bob('/equipment')).text.includes('/equipment/new'), 'viewer: no add button shown');
  ok((await carol('/equipment/new')).status === 200, 'editor: can add');
  ok((await carol(`/equipment/${idA}/delete`, { form: {} })).status === 403, 'editor: cannot delete by default');
  ok((await carol('/admin/email')).status === 403, 'editor: no admin settings');
  ok((await anon('/admin/users')).status === 302, 'logged out: admin redirects to login');
  ok((await anon(`/equipment/${idA}/delete`, { form: {} })).loc?.startsWith('/login'), 'logged out: delete redirected');

  ok((await bob('/admin/activity')).status === 403, 'viewer: no activity log by default');
  await alice('/admin/roles', { form: { viewer: ['equipment.export', 'audit.view', 'users.manage'], editor: ['equipment.view', 'equipment.edit', 'equipment.delete'] } });
  ok((await bob('/equipment/export.csv')).status === 200, 'role change applies immediately (viewer can export)');
  ok((await bob('/equipment')).status === 200, 'export permission implies view');
  ok((await bob('/admin/users')).status === 403, 'admin-only permission cannot be granted');
  r = await bob('/admin/activity');
  ok(r.status === 200 && r.text.includes('Invited user') && r.text.includes('href="/admin/activity"'), 'activity permission opens the log, with a nav link');
  r = await alice('/equipment/new', { form: { cert_no: 'DEL-ME', owner: 'x', department: 'x', type: 'x', serial_no: 'x', cal_date: '2026-01-01' } });
  const delId = r.loc.match(/equipment\/(\d+)/)[1];
  ok((await carol(`/equipment/${delId}/delete`, { form: {} })).loc === '/equipment', 'editor can delete once granted');

  // ---------- lockout guards ----------
  const aliceId = '1';
  const aliceForm = { name: 'Alice', email: 'alice@example.com', notify: '1' };
  ok((await alice(`/admin/users/${aliceId}`, { form: { ...aliceForm, role: 'viewer' } })).status === 400, 'cannot demote the only admin');
  ok((await alice(`/admin/users/${aliceId}/remove`, { form: {} })).status === 400, 'cannot remove the only admin');
  await alice(`/admin/users/${aliceId}`, { form: { ...aliceForm, role: 'admin', disabled: '1' } });
  ok((await alice('/equipment')).status === 200, 'cannot disable yourself');

  // disable carol -> her session stops
  await alice(`/admin/users/${carolInv.id}`, { form: { name: 'Carol', email: 'carol@example.com', role: 'editor', disabled: '1' } });
  ok((await carol('/equipment')).status === 302, 'disabled user is logged out');
  ok((await carol('/login', { form: { email: 'carol@example.com', password: pCarol } })).status === 403, 'disabled user cannot log in');

  // password reset link for bob
  await alice(`/admin/users/${bobInv.id}/link`, { form: {} });
  const resetLink = linkFrom((await alice(`/admin/users/${bobInv.id}`)).text);
  const pBob2 = pw();
  const bob2 = client();
  ok((await bob2(resetLink, { form: { password: pBob2, confirm: pBob2 } })).status === 302, 'password reset link works');
  ok((await bob('/equipment')).status === 302, 'reset logs out other sessions');
  ok((await bob('/login', { form: { email: 'bob@example.com', password: pBob } })).status === 401, 'old password no longer works');

  // promote bob, then alice can step down
  await alice(`/admin/users/${bobInv.id}`, { form: { name: 'Bob', email: 'bob@example.com', role: 'admin' } });
  ok((await alice(`/admin/users/${aliceId}`, { form: { ...aliceForm, role: 'editor' } })).status === 200, 'demote allowed once another admin exists');
  ok((await alice('/admin/users')).status === 403, 'demoted user loses admin access');
  ok((await bob2('/admin/users')).status === 200, 'new admin has access');

  // ---------- general settings ----------
  await bob2('/admin/general', { form: { app_name: 'Tringle Calibration', site_url: 'https://cal.example.com/', due_soon_days: '30' } });
  r = await bob2(`/equipment/${idA}/label`);
  ok(r.text.includes('https://cal.example.com/e/') && !r.text.includes('Trial address') && r.text.includes('Tringle Calibration'), 'site address + name used on labels');

  // ---------- login throttling ----------
  const mallory = client();
  for (let i = 0; i < 5; i++) await mallory('/login', { form: { email: 'bob@example.com', password: 'wrong-password' } });
  ok((await mallory('/login', { form: { email: 'bob@example.com', password: pBob2 } })).status === 429, 'login locked after 5 failures');

  // ---------- misc security ----------
  ok((await bob2(`/equipment/${idA}/delete`, { form: {}, headers: { origin: 'https://evil.example' } })).status === 403, 'cross-site post blocked');
  r = await bob2('/admin/activity');
  ok(r.text.includes('Invited user') && r.text.includes('Reminders sent'), 'activity log records actions');

  // ---------- reminders: a week later (catch-up + next threshold) ----------
  await stopServer();
  await startServer('2026-11-25');
  const bob3 = client();
  await bob3('/login', { form: { email: 'bob@example.com', password: pBob2 } });
  // Admin flags: alice is now an editor but still has notify on; bob doesn't
  mail.length = 0;
  r = await bob3('/admin/reminders/run', { form: {} });
  const digest = mail.find((m) => m.rcpt.includes('qa@example.com'));
  ok(digest && digest.data.includes('A-1') && digest.data.includes('B-2') && !digest.data.includes('C-3'), 'a week later: A and B reach the 7-day point, C not repeated');

  // edit with "new calibration" -> history kept, public page shows it
  await bob3(`/equipment/${idA}/edit`, { form: { ...base, cert_no: 'A-2', cal_date: '2026-11-24', cal_period: '24', keep_history: '1' } });
  r = await anon(pubA);
  ok(r.text.includes('Previous calibrations') && r.text.includes('A-1') && r.text.includes('<strong>Nov 2028</strong>') && new RegExp('A-1</td><td[^>]*>5 Nov 2025</td><td[^>]*>Nov 2026').test(r.text), 'new calibration with a 24-month period, old certificate kept in history');

  // ---------- automatic daily send (scheduler, no button) ----------
  await bob3('/equipment/new', { form: { cert_no: 'E-5', owner: 'Eve', department: 'Lab', type: 'Scale', serial_no: 'SE', cal_date: '2025-12-20', cal_period: '11' } }); // 11 months -> due Nov 2026
  await stopServer();
  mail.length = 0;
  await startServer('2026-11-26', { scheduler: true });
  for (let i = 0; i < 40 && !mail.length; i++) await new Promise((res) => setTimeout(res, 250));
  const auto = mail.find((m) => m.rcpt.includes('qa@example.com'));
  ok(auto && auto.data.includes('E-5') && !auto.data.includes('A-2'), 'scheduler sends the daily reminder on its own');
  const sentCount = mail.length;
  await new Promise((res) => setTimeout(res, 300));
  ok(mail.length === sentCount, 'scheduler sends only once per day');
} catch (err) {
  console.error(err);
  fails++;
} finally {
  await stopServer();
  smtp.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
