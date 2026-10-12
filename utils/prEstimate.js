// The size a PR environment is planned at until production can be measured: CI falls back to it, and
// the dashboard plans "room for N more" with it, so both give the same answer.
function prEstimateMiB(config) {
  let mib = 0;
  if (config.hasBackend) mib += 256;
  if (config.hasFrontend) mib += 128;
  if (config.hasDb) mib += 256;
  if (config.additionalServices && config.additionalServices.length > 0) mib += config.additionalServices.length * 128;
  return mib || 256;
}

module.exports = { prEstimateMiB };
