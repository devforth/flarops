// How the dashboard is reached and signed in to: its address, and a fresh password with the PBKDF2
// hash that is the only thing stored (deploy/.env, then the DASHBOARD_PASSWORD_HASH GitHub Secret).

const crypto = require('crypto');

// dashboard.<the domain without its first label>: dashboard.example.com for app.example.com, and for
// example.com itself.
function dashboardHost(domain) {
  const parts = String(domain || '').split('.');
  return `dashboard.${parts.length > 2 ? parts.slice(1).join('.') : domain}`;
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
function printDashboardLogin({ password, domain, reset = false }) {
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  console.log('');
  console.log(yellow('┌───────────────────────────────────────────────────────────────────────────┐'));
  console.log(yellow('│ DASHBOARD LOGIN - this is the only time this password is ever shown.      │'));
  console.log(yellow('└───────────────────────────────────────────────────────────────────────────┘'));
  if (domain) console.log(`    address:  ${bold(`https://${dashboardHost(domain)}`)}  (after the first deploy)`);
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

module.exports = { dashboardHost, newDashboardPassword, printDashboardLogin };
