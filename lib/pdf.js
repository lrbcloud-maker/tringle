// A PDF of one piece of equipment, laid out like its page: status, details, report tables, history.
// It contains only what the public scan page shows (never notes, contact email or document links).
const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cal = require('./calibration');
const { dueDate, formatDate, formatMonth, formatPeriod, formatDateTime, relative, todayStr } = require('./dates');
const { FIELDS, EXTRA_FIELDS, CAL_DETAIL_FIELDS, statusOf } = require('./views');

// DejaVu covers symbols that show up in calibration data (Ω µ ± ≤ ° –) which the built-in PDF fonts can't print.
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONTS = {
  regular: path.join(FONT_DIR, 'DejaVuSans.ttf'),
  bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  mono: path.join(FONT_DIR, 'DejaVuSansMono.ttf'),
};

const C = {
  text: '#1c1b19', muted: '#6f6b63', line: '#e3e0d9', head: '#faf9f7', accent: '#1d4f73',
  valid: ['#2f6b3a', '#e7f0e6'], 'due-soon': ['#8a5a00', '#f8eed8'], overdue: ['#a8321f', '#f8e5e0'], unfit: ['#a8321f', '#f8e5e0'],
};
const BANNER = { valid: 'Calibration in date', 'due-soon': 'Calibration due soon', overdue: 'Calibration expired. Do not use', unfit: 'Not fit for use. Do not use' };

const MARGIN = 42;

async function equipmentPdf(eq, { history = [], scanUrl, appName }) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true, info: { Title: `${eq.cert_no} – ${eq.type}`, Author: appName, Subject: 'Calibration record' } });
  doc.registerFont('regular', FONTS.regular);
  doc.registerFont('bold', FONTS.bold);
  doc.registerFont('mono', FONTS.mono);
  const W = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - 24; // leave room for the footer
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  const today = todayStr();
  const s = statusOf(eq, today);
  const due = dueDate(eq.cal_date, eq.cal_period);
  const qr = await QRCode.toBuffer(scanUrl, { width: 300, margin: 1, errorCorrectionLevel: 'M' });

  // ---------- header ----------
  const top = doc.y;
  doc.font('bold').fontSize(9).fillColor(C.accent).text(appName.toUpperCase(), MARGIN, top, { characterSpacing: 0.6, width: W - 90 });
  doc.moveDown(0.5);
  doc.font('mono').fontSize(10).fillColor(C.muted).text(eq.cert_no, { width: W - 90 });
  doc.font('bold').fontSize(20).fillColor(C.text).text(eq.type + (eq.cal_range ? `  ${eq.cal_range}` : ''), { width: W - 90 });
  doc.image(qr, MARGIN + W - 78, top - 4, { width: 78 });
  doc.y = Math.max(doc.y, top + 82) + 8;

  // ---------- status banner ----------
  const [fg, bg] = C[s];
  const by = doc.y;
  doc.rect(MARGIN, by, W, 30).fill(bg);
  doc.circle(MARGIN + 14, by + 15, 4).fill(fg);
  doc.font('bold').fontSize(11).fillColor(fg).text(BANNER[s], MARGIN + 26, by + 9, { width: W / 2 });
  doc.font('regular').fontSize(9).fillColor(C.text)
    .text(`Due ${relative(due, today)} · status as of ${formatDate(today)}`, MARGIN + W / 2, by + 11, { width: W / 2 - 12, align: 'right' });
  doc.y = by + 42;

  // ---------- details ----------
  const rows = [
    ...FIELDS.map((f) => [f.label, eq[f.key], f.mono]),
    ...EXTRA_FIELDS.filter((f) => eq[f.key]).map((f) => [f.label, eq[f.key], f.mono]),
    ['Date of calibration', formatDate(eq.cal_date)],
    ['Calibration period', formatPeriod(eq.cal_period)],
    ['Calibration due', `${formatMonth(due)}  (valid to ${formatDate(due)})`, false, true],
    ...(eq.result ? [['Result', cal.RESULTS[eq.result] || eq.result, false, true]] : []),
    ...CAL_DETAIL_FIELDS.filter((f) => eq[f.key]).map((f) => [f.label, eq[f.key], f.mono]),
    ...(eq.remarks ? [['Remarks', eq.remarks]] : []),
  ];
  const labelW = 150;
  for (const [label, value, mono, bold] of rows) {
    doc.font(mono ? 'mono' : bold ? 'bold' : 'regular').fontSize(10);
    const h = Math.max(doc.heightOfString(String(value || '—'), { width: W - labelW }), 12) + 10;
    ensure(h);
    const y = doc.y;
    doc.font('regular').fontSize(9.5).fillColor(C.muted).text(label, MARGIN, y + 5, { width: labelW - 10 });
    doc.font(mono ? 'mono' : bold ? 'bold' : 'regular').fontSize(10).fillColor(C.text).text(String(value || '—'), MARGIN + labelW, y + 5, { width: W - labelW });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + W, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.y = y + h;
  }

  // ---------- tables ----------
  const details = cal.parseDetails(eq.details);
  for (const [key, t] of Object.entries(cal.TABLES)) {
    if (!details[key] || !details[key].length) continue;
    table(t.label, t.cols.map(([, l]) => l), details[key].map((r) => t.cols.map(([c]) => r[c] || '—')), t.cols.map(([c]) => ['serial', 'cert'].includes(c)));
  }
  if (history.length) {
    table('Previous calibrations', ['Certificate', 'Calibrated', 'Was due', 'Result', 'By'], history.map((r) => {
      const snap = cal.parseSnapshot(r.snapshot);
      return [r.cert_no, formatDate(r.cal_date), formatMonth(dueDate(r.cal_date, r.cal_period)), cal.RESULTS[snap.result] || '—', snap.calibrated_by || '—'];
    }), [true]);
  }

  // ---------- footer on every page ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not start a new page
    const fy = doc.page.height - MARGIN + 4;
    doc.font('regular').fontSize(7.5).fillColor(C.muted);
    doc.text(`${appName} · generated ${formatDateTime(Date.now())} · ${scanUrl}`, MARGIN, fy, { width: W - 60, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN + W - 60, fy, { width: 60, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return doc;

  // A simple table that repeats its header row when it runs onto a new page.
  function table(title, headers, body, monoCols = []) {
    const n = headers.length;
    const colW = W / n;
    const padX = 5;
    const headerRow = () => {
      const y = doc.y;
      doc.rect(MARGIN, y, W, 18).fill(C.head);
      doc.font('bold').fontSize(7.5).fillColor(C.muted);
      headers.forEach((hd, i) => doc.text(hd.toUpperCase(), MARGIN + i * colW + padX, y + 5, { width: colW - padX * 2, characterSpacing: 0.4, lineBreak: false, ellipsis: true }));
      doc.y = y + 18;
    };
    ensure(64);
    doc.y += 14;
    doc.font('bold').fontSize(12).fillColor(C.text).text(title, MARGIN, doc.y);
    doc.y += 4;
    headerRow();
    for (const row of body) {
      const heights = row.map((v, i) => { doc.font(monoCols[i] ? 'mono' : 'regular').fontSize(9); return doc.heightOfString(String(v), { width: colW - padX * 2 }); });
      const h = Math.max(...heights, 10) + 10;
      if (doc.y + h > bottom()) { doc.addPage(); headerRow(); }
      const y = doc.y;
      row.forEach((v, i) => {
        doc.font(monoCols[i] ? 'mono' : 'regular').fontSize(9).fillColor(v === '—' ? C.muted : C.text)
          .text(String(v), MARGIN + i * colW + padX, y + 5, { width: colW - padX * 2 });
      });
      doc.moveTo(MARGIN, y + h).lineTo(MARGIN + W, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.y = y + h;
    }
  }
}

module.exports = { equipmentPdf };
