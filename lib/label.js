// QR sticker layout: size, text size, title, which details to show and an extra line.
// One saved layout is used for every label (single and bulk). Values always come from the record.
const QRCode = require('qrcode');
const settings = require('./settings');
const cal = require('./calibration');
const { dueDate, formatDate, formatMonth } = require('./dates');

const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SIZES = {
  '90x46': 'Standard, 90 × 46 mm',
  '100x50': 'Large, 100 × 50 mm',
  '70x35': 'Medium, 70 × 35 mm',
  '62x29': 'Small, 62 × 29 mm (Brother DK-11209)',
  '50x30': 'Mini, 50 × 30 mm',
  custom: 'Custom size',
};
const TEXT_SIZES = { small: ['Small', 7], normal: ['Normal', 8.5], large: ['Large', 10] };

// [key, label on the sticker, value from the record]
const LABEL_FIELDS = [
  ['cert_no', 'Cert no.', (e) => e.cert_no],
  ['serial_no', 'Serial', (e) => e.serial_no],
  ['type', 'Type', (e) => e.type],
  ['cal_range', 'Range', (e) => e.cal_range],
  ['manufacturer', 'Make', (e) => e.manufacturer],
  ['owner', 'Owner', (e) => e.owner],
  ['department', 'Dept.', (e) => e.department],
  ['cal_date', 'Calibrated', (e) => formatDate(e.cal_date)],
  ['due', 'Due', (e) => formatMonth(dueDate(e.cal_date, e.cal_period))],
  ['result', 'Result', (e) => cal.RESULTS[e.result] || ''],
  ['calibrated_by', 'By', (e) => e.calibrated_by],
];
const FIELD_KEYS = LABEL_FIELDS.map((f) => f[0]);

const DEFAULT = { size: '90x46', w: 90, h: 46, text: 'normal', showTitle: true, title: '', fields: ['cert_no', 'serial_no', 'type', 'cal_date', 'due'], extra: '' };

const clamp = (n, lo, hi, d) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Turn any input (saved JSON or a posted form) into a safe layout.
function normalise(input = {}) {
  const size = SIZES[input.size] ? input.size : DEFAULT.size;
  let w; let hh;
  if (size === 'custom') {
    w = clamp(Number(input.w), 40, 150, DEFAULT.w);
    hh = clamp(Number(input.h), 20, 100, DEFAULT.h);
  } else {
    [w, hh] = size.split('x').map(Number);
  }
  const fields = [].concat(input.fields ?? DEFAULT.fields).filter((k) => FIELD_KEYS.includes(k));
  return {
    size, w, h: hh,
    text: TEXT_SIZES[input.text] ? input.text : DEFAULT.text,
    showTitle: input.showTitle === undefined ? DEFAULT.showTitle : input.showTitle === true || input.showTitle === '1',
    title: cleanText(input.title, 60),
    fields: FIELD_KEYS.filter((k) => fields.includes(k)), // keep a fixed order
    extra: cleanText(input.extra, 80),
  };
}

function getLayout() {
  try { return normalise(JSON.parse(settings.get('label_layout') || '{}')); } catch { return normalise({}); }
}

function saveLayout(input) {
  const layout = normalise(input);
  settings.set('label_layout', JSON.stringify(layout));
  return layout;
}

// CSS variables for the size and text size; set on the element that wraps the labels.
const styleVars = (l) => `--lw:${l.w}mm;--lh:${l.h}mm;--lfs:${TEXT_SIZES[l.text][1]}pt`;

// Every possible line is rendered (hidden when not chosen) so the editor can preview changes instantly.
async function labelHtml(eq, layout, url, appName) {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  const lines = LABEL_FIELDS.map(([key, label, get]) => {
    const value = get(eq) || '';
    return `<div data-lf="${key}"${layout.fields.includes(key) && value ? '' : ' hidden'}${value ? '' : ' data-empty'}${key === 'due' ? ' class="label-due"' : ''}><span class="k">${label}</span> <span class="v">${h(value)}</span></div>`;
  }).join('');
  return `
    <div class="label">
      <div class="label-qr">${svg}</div>
      <div class="label-text">
        <div class="label-title" data-label-title data-default="${h(appName)}"${layout.showTitle ? '' : ' hidden'}>${h(layout.title || appName)}</div>
        ${lines}
        <div class="label-extra" data-label-extra${layout.extra ? '' : ' hidden'}>${h(layout.extra)}</div>
      </div>
    </div>`;
}

// The settings panel shown next to the labels.
function editorHtml(layout, { canSave, back, appName }) {
  const opt = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${h(Array.isArray(v) ? v[0] : v)}</option>`).join('');
  return `
  <form method="post" action="/labels/layout" class="panel label-editor no-print" data-label-editor>
    <div class="panel-head"><h2>Sticker layout</h2></div>
    <div class="panel-body form">
      <input type="hidden" name="back" value="${h(back)}">
      <label class="field"><span>Size</span><select name="size">${opt(SIZES, layout.size)}</select></label>
      <div class="grid-2" data-custom-size ${layout.size === 'custom' ? '' : 'hidden'}>
        <label class="field"><span>Width (mm)</span><input type="number" name="w" min="40" max="150" value="${layout.w}"></label>
        <label class="field"><span>Height (mm)</span><input type="number" name="h" min="20" max="100" value="${layout.h}"></label>
      </div>
      <label class="field"><span>Text size</span><select name="text">${opt(TEXT_SIZES, layout.text)}</select></label>
      <div class="field">
        <label class="check"><input type="checkbox" name="showTitle" value="1" ${layout.showTitle ? 'checked' : ''}><span>Show a title</span></label>
        <input type="text" name="title" maxlength="60" value="${h(layout.title)}" placeholder="${h(appName)}" aria-label="Title text">
      </div>
      <fieldset class="field">
        <span class="computed-label">Details on the sticker</span>
        <div class="check-grid">
          ${LABEL_FIELDS.map(([key, label]) => `<label class="check"><input type="checkbox" name="fields" value="${key}" ${layout.fields.includes(key) ? 'checked' : ''}><span>${key === 'due' ? 'Due date' : key === 'cal_date' ? 'Calibrated date' : label.replace('.', '')}</span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field"><span>Extra line</span><input type="text" name="extra" maxlength="80" value="${h(layout.extra)}" placeholder="e.g. Do not use after the due date"><span class="hint">Printed at the bottom of every sticker.</span></label>
      <p class="small muted" style="margin:0">Changes show on the sticker straight away. The QR code always stays black on white so it scans.</p>
      <p class="small" data-fit-note hidden style="margin:0;color:var(--warn)">The text has been made smaller so it fits. Choose fewer details or a bigger sticker for larger text.</p>
    </div>
    <div class="panel-foot">
      ${canSave ? `<button class="btn btn-primary">Save as default</button><button class="btn btn-quiet" name="reset" value="1" data-confirm-reset>Reset</button>` : '<span class="small muted">You can print with these changes. Only editors can save them as the default.</span>'}
    </div>
  </form>`;
}

module.exports = { SIZES, TEXT_SIZES, LABEL_FIELDS, DEFAULT, normalise, getLayout, saveLayout, styleVars, labelHtml, editorHtml };
