const os = require('node:os');
const settings = require('./settings');

const PORT = Number(process.env.PORT) || 3000;
const ENV_BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');

function detectLanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  const preferred = all.find((i) => /^(192\.168\.|10\.)/.test(i.address)) || all[0];
  return preferred ? preferred.address : 'localhost';
}
const LAN_IP = detectLanIp();
const LAN_URL = `http://${LAN_IP}:${PORT}`;

// The address put in QR codes and emails: BASE_URL env > "Site address" setting > this PC's network address.
function configuredBaseUrl() {
  return ENV_BASE_URL || settings.get('site_url').replace(/\/+$/, '');
}

function baseUrl(req) {
  const configured = configuredBaseUrl();
  if (configured) return configured;
  if (!req) return LAN_URL;
  // A QR code pointing at "localhost" would not work on a phone, so swap in this PC's network address.
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(req.hostname)) return LAN_URL;
  return `${req.protocol}://${req.get('host')}`;
}

const isTrialAddress = () => !configuredBaseUrl();
const appName = () => settings.get('app_name') || 'Calibration Register';
const secureCookies = () => ENV_BASE_URL.startsWith('https://') || process.env.SECURE_COOKIES === '1';

module.exports = { PORT, ENV_BASE_URL, LAN_IP, LAN_URL, baseUrl, configuredBaseUrl, isTrialAddress, appName, secureCookies };
