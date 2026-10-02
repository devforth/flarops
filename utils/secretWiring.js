// Who reads which secret under which name: one canonical Secret key per shared credential,
// mapped to each consumer's own env name.

const crypto = require('crypto');

class SecretWiring {
  constructor() {
    // variable name in compose -> { secretKey, value }
    this.credentials = new Map();
    this.api = { forcedKeys: new Set(), mappings: [] };
    this.frontend = { forcedKeys: new Set(), mappings: [] };
  }

  // First registration wins: a later consumer must not rename a key others are wired to.
  registerCredential(varName, secretKeyName) {
    if (this.credentials.has(varName)) return this.credentials.get(varName);
    const entry = { secretKey: secretKeyName, value: crypto.randomBytes(16).toString('hex') };
    this.credentials.set(varName, entry);
    return entry;
  }

  has(varName) { return this.credentials.has(varName); }
  get(varName) { return this.credentials.get(varName); }
  entries() { return this.credentials.values(); }

  wire(target, envName, secretKey) {
    const forced = target.forcedKeys || target.forcedSecretKeys;
    const mappings = target.mappings || target.extraSecretEnvMappings;
    if (envName === secretKey) {
      forced.add(envName);
      return;
    }
    if (!mappings.some(m => m.envName === envName)) mappings.push({ envName, secretKey });
  }
}

// Secret keys some workload mounts, derived the same way the templates derive them.
function mountedSecretKeys(config) {
  const keys = new Set();
  const add = (key) => { if (key) keys.add(key); };
  const addAll = (list) => { for (const k of list || []) add(k); };
  const addMappings = (list) => { for (const m of list || []) add(m.secretKey); };

  add('DASHBOARD_PASSWORD_HASH');

  if (config.hasBackend) {
    addAll(config.apiSecretKeys);
    addMappings(config.apiExtraSecretEnvMappings);
  }
  if (config.hasFrontend) {
    addAll(config.frontendSecretKeys);
    addMappings(config.frontendExtraSecretEnvMappings);
  }
  if (config.hasDbPassword) add(config.dbPasswordKey);

  for (const service of config.additionalServices || []) {
    addAll(service.secretKeys);
    addMappings(service.extraSecretEnvMappings);
    add(service.dbPasswordKey);
    add(service.springDatasourcePasswordSecretKey);
    if (service.db) add(service.db.passwordKey);
  }
  for (const service of config.supportServices || []) {
    addAll(service.secretKeys);
    addMappings(service.extraSecretEnvMappings);
  }

  return keys;
}

function unmountedSecretKeys(config) {
  const mounted = mountedSecretKeys(config);
  return (config.envKeysToPass || []).filter(key => key && !mounted.has(key));
}

module.exports = { SecretWiring, mountedSecretKeys, unmountedSecretKeys };
