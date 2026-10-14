// The size a PR environment is planned at until production can be measured: CI falls back to it, and
// the dashboard plans "room for N more" with it, so both give the same answer.
function prEstimateMiB(config) {
  const additional = config.additionalServices || [];
  const support = config.supportServices || [];
  let mib = 0;
  if (config.hasBackend) mib += 256;
  if (config.hasFrontend) mib += 128;
  if (config.hasDb) mib += 256;
  mib += additional.length * 128;
  mib += support.length * 128;
  mib += [...additional, ...support].filter(s => s && s.db && !s.db.shared).length * 256;
  return mib || 256;
}

module.exports = { prEstimateMiB };
