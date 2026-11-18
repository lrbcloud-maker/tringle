const path = require('node:path');
const express = require('express');

const { DB_PATH } = require('./lib/db');
const auth = require('./lib/auth');
const site = require('./lib/site');
const reminders = require('./lib/reminders');
const { layout } = require('./lib/views');
const { notFound, homeFor } = require('./lib/http');

const app = express();
if (site.secureCookies() || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '2mb', parameterLimit: 5000 })); // import review can post many rows
app.use((req, res, next) => { if (!req.body) req.body = {}; next(); }); // Express 5 leaves it undefined for empty posts

// Reject form posts coming from other websites.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return res.status(403).send('Request blocked.');
  }
  next();
});

app.use((req, res, next) => {
  req.user = auth.currentUser(req);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  if (req.user) res.set('Cache-Control', 'no-store');
  next();
});

app.get('/', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.redirect(auth.userCount() === 0 ? '/setup' : '/login');
});

app.use(require('./routes/auth').router);
app.use(require('./routes/import').router);
app.use(require('./routes/equipment').router);
app.use(require('./routes/admin').router);

app.use(notFound);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send(layout({ req, title: 'Error', bare: !req.user, body: '<section class="panel narrow"><div class="panel-body"><h1>Something went wrong</h1><p class="muted">Please try again. If it keeps happening, check the server log.</p></div></section>' }));
});

process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));

app.listen(site.PORT, '0.0.0.0', () => {
  console.log(`${site.appName()} running`);
  console.log(`  On this PC:        http://localhost:${site.PORT}`);
  console.log(`  On your network:   ${site.LAN_URL}`);
  console.log(`  QR codes point to: ${site.configuredBaseUrl() || `${site.LAN_URL} (trial; set the site address when live)`}`);
  console.log(`  Database:          ${DB_PATH}`);
  if (process.env.NO_SCHEDULER !== '1') reminders.startScheduler();
});
