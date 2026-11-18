const nodemailer = require('nodemailer');
const settings = require('./settings');

function smtpConfigured() {
  return Boolean(settings.get('smtp_host') && settings.get('smtp_from'));
}

function transport() {
  const security = settings.get('smtp_security');
  const user = settings.get('smtp_user');
  return nodemailer.createTransport({
    host: settings.get('smtp_host'),
    port: settings.num('smtp_port') || 587,
    secure: security === 'ssl',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: user ? { user, pass: settings.get('smtp_pass') } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

async function send({ to, subject, text, html }) {
  if (!smtpConfigured()) throw new Error('Email is not set up yet. Fill in the SMTP settings first.');
  const t = transport();
  try {
    return await t.sendMail({ from: settings.get('smtp_from'), to, subject, text, html });
  } finally {
    t.close();
  }
}

// Turn SMTP errors into something readable, without echoing credentials.
function describeError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/EAUTH|Invalid login|535/i.test(msg)) return 'The SMTP server rejected the username or password.';
  if (/ECONNREFUSED/i.test(msg)) return 'Could not connect: the server refused the connection. Check the host and port.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'Could not find that SMTP server. Check the host name.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'The connection timed out. Check the host, port and security setting.';
  if (/wrong version number|SSL routines|self.signed|certificate/i.test(msg)) return 'Secure connection failed. Try a different security option (SSL usually uses port 465, STARTTLS port 587).';
  return msg.replace(/pass(word)?\S*/gi, '').slice(0, 300);
}

module.exports = { send, smtpConfigured, describeError };
