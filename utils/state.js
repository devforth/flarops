// What init worked out, persisted for sync in deploy/.flarops-state.json (committed).
// Names, paths and ports only - never a secret's value.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeWriteFile } = require('./safeWrite.js');
const { shippedDashboardFiles } = require('./dashboardFiles.js');

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
  // The dashboard files this version ships, so a later sync removes only those a newer one drops.
  if (state.dashboardFiles === undefined) state.dashboardFiles = shippedDashboardFiles();
  safeWriteFile(currentDir, STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// What a generated file held when sync last rendered it; line endings are not a difference.
function contentHash(content) {
  const text = Buffer.isBuffer(content) ? content : Buffer.from(String(content).replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(text).digest('hex');
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

module.exports = { writeState, readState, statePath, contentHash, STATE_FILE };
