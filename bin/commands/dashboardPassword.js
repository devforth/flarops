// `flarops dashboard-password`: replace a lost dashboard password without regenerating anything.

const fs = require('fs');
const path = require('path');
const { EnvFile } = require('../../utils/envFile.js');
const { readState } = require('../../utils/state.js');
const { newDashboardPassword, printDashboardLogin } = require('../../utils/dashboardAccess.js');
const { enterProjectRoot } = require('../../utils/projectRoot.js');

module.exports = async function dashboardPassword() {
  if (!enterProjectRoot()) {
    console.error('\x1b[31mERROR: no flarops.yaml here or in any directory above, up to the repository root - run this inside a project Flarops has set up.\x1b[0m');
    process.exit(1);
  }
  const currentDir = process.cwd();
  let state = null;
  try { state = readState(currentDir); } catch (e) { /* the domain is only shown */ }

  const envIO = new EnvFile(fs, path.join(currentDir, 'deploy', '.env'));
  const { password, hash } = newDashboardPassword();
  const line = `DASHBOARD_PASSWORD_HASH='${hash}'`;
  if (envIO.has('DASHBOARD_PASSWORD_HASH')) {
    const current = envIO.read();
    fs.writeFileSync(envIO.path, current.replace(/^DASHBOARD_PASSWORD_HASH=.*$/m, () => line));
  } else {
    fs.mkdirSync(path.dirname(envIO.path), { recursive: true });
    envIO.append(`${envIO.read() && !envIO.read().endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  try { fs.chmodSync(envIO.path, 0o600); } catch (e) { /* best effort */ }

  printDashboardLogin({ password, domain: state && state.domain, reset: true });
};
