// `flarops dashboard-password`: replace a lost dashboard password without regenerating anything.

const path = require('path');
const { safeReadFile, safeWriteFile, SymlinkError } = require('../../utils/safeWrite.js');
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

  // deploy/.env holds the secrets: never read or written through a link, and 0600 from the first byte.
  const envRel = path.join('deploy', '.env');
  const { password, hash } = newDashboardPassword();
  const line = `DASHBOARD_PASSWORD_HASH='${hash}'`;
  try {
    const current = safeReadFile(currentDir, envRel) || '';
    const content = /^DASHBOARD_PASSWORD_HASH=.*$/m.test(current)
      ? current.replace(/^DASHBOARD_PASSWORD_HASH=.*$/m, () => line)
      : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
    safeWriteFile(currentDir, envRel, content, { mode: 0o600 });
  } catch (e) {
    if (!(e instanceof SymlinkError)) throw e;
    console.error(`\x1b[31mERROR: ${e.message}\x1b[0m`);
    console.error('Nothing was written.');
    process.exit(1);
  }

  printDashboardLogin({ password, domain: state && state.domain, reset: true, tls: !!(state && state.hasCloudflare) });
};
