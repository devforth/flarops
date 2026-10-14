// How the dashboard is reached and signed in to: its address, and a fresh password with the PBKDF2
// hash that is the only thing stored (deploy/.env, then the DASHBOARD_PASSWORD_HASH GitHub Secret).

const crypto = require('crypto');

// Public suffixes of more than one label: under them the domain itself is the zone, so the hosts
// below go under the domain, never next to it (shop.co.uk -> dashboard.shop.co.uk, not dashboard.co.uk).
const MULTI_LABEL_SUFFIXES = [
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'co.nz', 'net.nz', 'org.nz',
  'com.br', 'net.br', 'org.br', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr',
  'co.za', 'org.za', 'co.in', 'net.in', 'org.in', 'co.il', 'org.il', 'co.id', 'co.th',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.tr', 'com.cn', 'net.cn', 'org.cn', 'com.hk',
  'com.tw', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.pl', 'com.ua', 'com.sa', 'com.eg',
  'com.ng', 'co.ke',
];

// Where the dashboard and PR hosts sit: the domain without its first label (example.com for
// app.example.com), or the domain itself when it is an apex (example.com, shop.co.uk).
function hostParent(domain) {
  const d = String(domain || '');
  const parts = d.split('.');
  const rest = parts.slice(1).join('.');
  return parts.length > 2 && !MULTI_LABEL_SUFFIXES.includes(rest) ? rest : d;
}

function dashboardHost(domain) {
  return `dashboard.${hostParent(domain)}`;
}

// app-pr-7.example.com for app.example.com, pr-7.example.com for example.com.
function prHost(domain, number) {
  const parent = hostParent(domain);
  return parent === String(domain || '') ? `pr-${number}.${parent}` : `${String(domain).split('.')[0]}-pr-${number}.${parent}`;
}

// Without Cloudflare nothing terminates TLS: the server serves plain HTTP on port 80.
function appScheme(config) {
  return config && config.hasCloudflare ? 'https' : 'http';
}

function newDashboardPassword() {
  const password = crypto.randomBytes(18).toString('base64url');
  const salt = crypto.randomBytes(16);
  const iterations = 600000;
  const derived = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
  return { password, hash: `pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(derived)}` };
}

// The one-time box with the sign-in details; `reset` words it for a replaced password.
function printDashboardLogin({ password, domain, reset = false, tls = true }) {
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  console.log('');
  console.log(yellow('┌───────────────────────────────────────────────────────────────────────────┐'));
  console.log(yellow('│ DASHBOARD LOGIN - this is the only time this password is ever shown.      │'));
  console.log(yellow('└───────────────────────────────────────────────────────────────────────────┘'));
  if (domain) console.log(`    address:  ${bold(`${tls ? 'https' : 'http'}://${dashboardHost(domain)}`)}  (after the first deploy)`);
  if (domain && !tls) console.log('              plain HTTP: HTTPS needs a proxy (Cloudflare, for example) in front of the server.');
  console.log(`    username: ${bold('admin')}`);
  console.log(`    password: ${bold(password)}`);
  console.log('');
  console.log('    Store it in your password manager now. Only its hash is kept (DASHBOARD_PASSWORD_HASH');
  console.log('    in deploy/.env), so it cannot be recovered - a lost password is replaced with');
  console.log('    "npx flarops dashboard-password".');
  if (reset) {
    console.log('');
    console.log('    Now copy the new DASHBOARD_PASSWORD_HASH from deploy/.env into the GitHub secret of the');
    console.log('    same name (paste the value without its quotes), then redeploy: push to the deploy branch');
    console.log('    or re-run the deploy workflow. The old password works until then.');
  }
  console.log('');
}

module.exports = { MULTI_LABEL_SUFFIXES, hostParent, dashboardHost, prHost, appScheme, newDashboardPassword, printDashboardLogin };
