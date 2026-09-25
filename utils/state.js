// The deployment state `flarops init` worked out, persisted for `flarops sync`.
//
// Written to deploy/.flarops-state.json and meant to be COMMITTED: sync runs
// on a fresh clone and in CI, where nothing from the original init survives.
// It holds names, paths, ports and key names - never a credential's value.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join('deploy', '.flarops-state.json');

// A Set does not survive JSON, and forcedSecretKeys is one. Anything else that
// is not plain data would be lost the same way, so it is converted here rather
// than discovered missing later.
function serializable(value) {
  if (value instanceof Set) return Array.from(value);
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializable(v)]));
  }
  return value;
}

function statePath(currentDir) {
  return path.join(currentDir, STATE_FILE);
}

// A service's `path` is an ABSOLUTE path on the machine init ran on. This file
// is committed and read again on a fresh clone and in CI, where that path
// names nothing - so it is dropped on the way out and rebuilt from
// relativePath, which carries the same fact without the machine attached.
function writeState(currentDir, config) {
  const state = serializable(config);
  for (const service of state.additionalServices || []) delete service.path;
  fs.writeFileSync(statePath(currentDir), JSON.stringify(state, null, 2) + '\n');
}

function readState(currentDir) {
  const file = statePath(currentDir);
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // forcedSecretKeys comes back as an array; the templates that read it
    // expect a Set.
    for (const service of state.additionalServices || []) {
      service.forcedSecretKeys = new Set(service.forcedSecretKeys || []);
      service.path = path.resolve(currentDir, service.relativePath || '.');
    }
    return state;
  } catch (e) {
    const err = new Error(`${STATE_FILE} is not readable JSON: ${e.message}`);
    err.corrupt = true;
    throw err;
  }
}

module.exports = { writeState, readState, statePath, STATE_FILE };
