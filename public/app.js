(function () {
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- theme ----------
  function applyTheme(theme, animate) {
    if (animate && !reduceMotion) {
      root.classList.add('theme-fade');
      clearTimeout(applyTheme.timer);
      applyTheme.timer = setTimeout(function () { root.classList.remove('theme-fade'); }, 450);
    }
    root.setAttribute('data-theme', theme);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch (err) { /* private mode */ }
    applyTheme(next, true);
  });

  // Follow the system setting until the user picks one.
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      var saved = null;
      try { saved = localStorage.getItem('theme'); } catch (err) { /* ignore */ }
      if (saved !== 'light' && saved !== 'dark') applyTheme(mq.matches ? 'dark' : 'light', true);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }

  // Theme choice on the account page.
  document.addEventListener('change', function (e) {
    if (!e.target.matches('[name="theme_choice"]')) return;
    var v = e.target.value;
    try {
      if (v === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', v);
    } catch (err) { /* ignore */ }
    var t = v === 'system' ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : v;
    applyTheme(t, true);
  });
  document.querySelectorAll('[name="theme_choice"]').forEach(function (r) {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (err) { /* ignore */ }
    r.checked = r.value === (saved === 'light' || saved === 'dark' ? saved : 'system');
  });

  // ---------- confirm before destructive actions ----------
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // ---------- copy buttons ----------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var input = document.getElementById(btn.getAttribute('data-copy'));
    if (!input) return;
    input.select();
    var done = function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });

  // ---------- live "calibration due" preview ----------
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Due = end of the month that is <period> months after the calibration month (same rule as the server).
  document.querySelectorAll('[data-due-from]').forEach(function (out) {
    var input = document.getElementById(out.getAttribute('data-due-from'));
    var periodInput = document.getElementById(out.getAttribute('data-period-from'));
    var until = out.parentNode.querySelector('[data-valid-until]');
    if (!input) return;
    var update = function () {
      var v = input.value;
      var months = periodInput ? Number(periodInput.value) : 12;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !(months >= 1 && months <= 120 && Math.floor(months) === months)) {
        out.textContent = '—';
        if (until) until.textContent = 'Calibration date + period, rounded to the month';
        return;
      }
      var p = v.split('-').map(Number);
      var idx = (p[1] - 1) + months;
      var y = p[0] + Math.floor(idx / 12), m = idx % 12;
      var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      out.textContent = M[m] + ' ' + y;
      if (until) until.textContent = 'Valid until ' + last + ' ' + M[m] + ' ' + y;
    };
    [input, periodInput].forEach(function (el) {
      if (!el) return;
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    });
    update();
  });

  // Period quick-pick buttons
  document.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-period]');
    if (!chip) return;
    var p = document.getElementById('cal_period');
    p.value = chip.getAttribute('data-period');
    p.dispatchEvent(new Event('input', { bubbles: true }));
  });
  function markChip() {
    var p = document.getElementById('cal_period');
    if (!p) return;
    document.querySelectorAll('[data-period]').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === p.value); });
  }
  document.addEventListener('input', function (e) { if (e.target.id === 'cal_period') markChip(); });
  markChip();

  // Show the "keep old certificate" option only when the certificate or date actually changes.
  var hist = document.querySelector('[data-history-toggle]');
  if (hist) {
    var cert = document.getElementById('cert_no'), cal = document.getElementById('cal_date');
    var orig = [cert.value, cal.value];
    var sync = function () { hist.hidden = cert.value === orig[0] && cal.value === orig[1]; };
    cert.addEventListener('input', sync); cal.addEventListener('input', sync); cal.addEventListener('change', sync); sync();
  }

  // ---------- bulk select on the register ----------
  var all = document.querySelector('[data-select-all]');
  var bulk = document.querySelector('[data-bulk-count]');
  function refreshBulk() {
    var boxes = document.querySelectorAll('[data-select-row]');
    var n = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length;
    if (bulk) {
      bulk.textContent = n ? n + ' selected' : '';
      var btn = document.querySelector('[data-bulk-btn]');
      if (btn) btn.disabled = !n;
    }
    if (all) { all.checked = n && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
  }
  if (all) all.addEventListener('change', function () {
    document.querySelectorAll('[data-select-row]').forEach(function (b) { b.checked = all.checked; });
    refreshBulk();
  });
  document.addEventListener('change', function (e) { if (e.target.matches('[data-select-row]')) refreshBulk(); });
  refreshBulk();

  // ---------- SMTP presets ----------
  var sec = document.getElementById('smtp_security'), port = document.getElementById('smtp_port');
  if (sec && port) sec.addEventListener('change', function () {
    var def = { ssl: '465', starttls: '587', none: '25' }[sec.value];
    if (['465', '587', '25', ''].indexOf(port.value) !== -1) port.value = def;
  });

  // ---------- register: show/hide the extra filters ----------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle-filters]');
    if (!btn) return;
    var panel = document.getElementById(btn.getAttribute('aria-controls'));
    var open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var first = panel.querySelector('select, input'); if (first) first.focus(); }
  });
  // Don't send empty filter fields, so the address stays short and readable.
  document.querySelectorAll('.filters-form').forEach(function (form) {
    form.addEventListener('submit', function () {
      form.querySelectorAll('input, select').forEach(function (el) { if (el.name && !el.value) el.disabled = true; });
    });
  });

  // ---------- table row editors (reference instruments, readings, checks) ----------
  document.addEventListener('click', function (e) {
    var add = e.target.closest('[data-row-add]');
    if (add) {
      var key = add.getAttribute('data-row-add');
      var tpl = document.querySelector('[data-row-template="' + key + '"]');
      var body = document.querySelector('[data-rows="' + key + '"]');
      body.appendChild(tpl.content.cloneNode(true));
      var newRow = body.lastElementChild;
      newRow.querySelectorAll('[data-combo]').forEach(function (box) { // each copy needs its own id
        var id = 'c' + Math.random().toString(36).slice(2, 9);
        var inp = box.querySelector('input'), ul = box.querySelector('.combo-list');
        inp.id = id; ul.id = id + '-list'; inp.setAttribute('aria-controls', ul.id);
        if (window.__setupCombo) window.__setupCombo(box);
      });
      var inputs = newRow.querySelectorAll('input:not([type="hidden"])');
      if (inputs[0]) inputs[0].focus();
      return;
    }
    var rm = e.target.closest('[data-row-remove]');
    if (rm) rm.closest('tr').remove();
  });

  // ---------- Excel upload: show chosen files, drag and drop ----------
  document.querySelectorAll('[data-dropzone]').forEach(function (zone) {
    var input = zone.querySelector('input[type="file"]');
    var list = zone.querySelector('[data-dropzone-files]');
    var show = function () {
      var names = Array.prototype.map.call(input.files, function (f) { return f.name; });
      list.textContent = names.length ? (names.length > 3 ? names.length + ' files selected' : names.join(', ')) : '';
    };
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
    });
  });

  // ---------- pick-or-add dropdowns (type, owner, department ...) ----------
  function setupCombo(box) {
    if (box._combo) return;
    box._combo = true;
    var input = box.querySelector('input');
    var list = box.querySelector('.combo-list');
    var toggle = box.querySelector('.combo-toggle');
    var baseOptions = [];
    try { baseOptions = JSON.parse(box.querySelector('[data-combo-options]').textContent) || []; } catch (err) { baseOptions = []; }
    var options = baseOptions;
    // Optionally also offer the current values of other fields on the page (e.g. reference instruments as apparatus).
    var from = box.getAttribute('data-options-from');
    function refreshOptions() {
      if (!from) return;
      var seen = {}, out = [];
      document.querySelectorAll('[name="' + from + '"]').forEach(function (el) {
        var v = el.value.trim();
        if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); }
      });
      baseOptions.forEach(function (v) { if (!seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } });
      options = out;
    }
    var newLabel = box.getAttribute('data-new-label') || 'Add';
    var active = -1;

    function items() { return list.querySelectorAll('[role="option"]'); }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; }
    var choosing = false;
    function choose(v) {
      input.value = v;
      close();
      choosing = true;
      input.dispatchEvent(new Event('input', { bubbles: true })); // let other scripts react to the new value
      choosing = false;
      input.focus();
    }
    function highlight(i) {
      var all = items();
      if (!all.length) return;
      active = (i + all.length) % all.length;
      all.forEach(function (el, n) { el.classList.toggle('active', n === active); el.setAttribute('aria-selected', n === active ? 'true' : 'false'); });
      all[active].scrollIntoView({ block: 'nearest' });
    }
    function render(showAll) {
      refreshOptions();
      var q = input.value.trim().toLowerCase();
      var shown = showAll || !q ? options : options.filter(function (o) { return o.toLowerCase().indexOf(q) !== -1; });
      var exact = options.some(function (o) { return o.toLowerCase() === q; });
      list.innerHTML = '';
      shown.forEach(function (o) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = o;
        if (o.toLowerCase() === q) li.classList.add('current');
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(o); });
        list.appendChild(li);
      });
      if (q && !exact) {
        var add = document.createElement('li');
        add.setAttribute('role', 'option');
        add.className = 'combo-new';
        add.textContent = newLabel + ' “' + input.value.trim() + '”';
        add.addEventListener('mousedown', function (e) { e.preventDefault(); choose(input.value.trim()); });
        list.appendChild(add);
      }
      if (!list.children.length) {
        var empty = document.createElement('li');
        empty.className = 'combo-empty';
        empty.textContent = 'Nothing saved yet. Type to add one.';
        list.appendChild(empty);
      }
      place();
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    }
    // The list floats above the page so it isn't cut off inside scrolling tables.
    function place() {
      var r = input.getBoundingClientRect();
      var below = window.innerHeight - r.bottom;
      list.style.left = r.left + 'px';
      list.style.width = Math.max(r.width, 180) + 'px';
      if (below < 220 && r.top > below) { list.style.top = ''; list.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
      else { list.style.bottom = ''; list.style.top = (r.bottom + 4) + 'px'; }
    }
    window.addEventListener('scroll', function (e) { if (!list.hidden && !list.contains(e.target)) place(); }, true);
    window.addEventListener('resize', function () { if (!list.hidden) place(); });

    toggle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      if (list.hidden) { input.focus(); render(true); } else close();
    });
    input.addEventListener('input', function () { if (!choosing && document.activeElement === input) render(false); });
    input.addEventListener('click', function () { if (list.hidden) render(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(true); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) render(true); highlight(active - 1); }
      else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); var el = items()[active]; choose(el.classList.contains('combo-new') ? input.value.trim() : el.textContent); }
      else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close();
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
  }
  document.querySelectorAll('[data-combo]').forEach(setupCombo);
  window.__setupCombo = setupCombo;

  // ---------- readings: error = specified − measured (same rule as the server) ----------
  function parseMeasure(s) {
    var text = String(s || '').trim();
    if (!text) return null;
    var bracket = text.match(/\(([^)]*\d[^)]*)\)/);
    var m = (bracket ? bracket[1] : text).match(/-?\d+(?:[.,]\d+)?/);
    if (!m) return null;
    var n = Number(m[0].indexOf(',') !== -1 && m[0].indexOf('.') === -1 ? m[0].replace(',', '.') : m[0]);
    return isFinite(n) ? n : null;
  }
  function updateError(row) {
    var nom = row.querySelector('[data-nominal]'), meas = row.querySelector('[data-measured]'), err = row.querySelector('[data-error]');
    if (!nom || !meas || !err) return;
    var a = parseMeasure(nom.value), b = parseMeasure(meas.value);
    if (a === null || b === null) {
      if (err.readOnly) { err.readOnly = false; err.classList.remove('computed-input'); err.value = ''; }
      return;
    }
    var v = Number((a - b).toFixed(3));
    err.value = String(v === 0 ? 0 : v);
    err.readOnly = true;
    err.classList.add('computed-input');
    err.title = 'Calculated: specified − measured';
  }
  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-nominal], [data-measured]')) updateError(e.target.closest('tr'));
  });

  // Print button
  document.addEventListener('click', function (e) { if (e.target.closest('[data-print]')) window.print(); });
})();
