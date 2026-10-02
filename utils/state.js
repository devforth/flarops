// What init worked out, persisted for sync in deploy/.flarops-state.json (committed).
// Names, paths and ports only - never a secret's value.

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join('deploy', '.flarops-state.json');

// A Set does not survive JSON.
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

// `path` is absolute and machine-specific; it is rebuilt from relativePath on read.
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
