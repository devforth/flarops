// Who reads which secret, under which name.
//
// docker-compose routinely reads ONE credential into several settings: a
// database declares POSTGRES_PASSWORD: ${DB_PASS} while the backend reads
// DB_PASSWORD: ${DB_PASS}. Both are the same secret; only the container-side
// name differs. Flarops picks one canonical key per variable and wires every
// consumer to it.
//
// This lived in init.js as five bare collections - a Map and four
// Sets/arrays - mutated directly from four hundred lines apart, with the rule
// that decides between them written out three times (once for the backend,
// once for the frontend, once per additional service). Three copies of a rule
// is three chances for a fix to reach two of them, which is exactly how the
// duplicate-env bug survived its first fix earlier in this project.
//
// A consumer whose env name IS the canonical key needs nothing but the key in
// its secretKeys list; one whose name differs needs an explicit mapping, so
// the chart can point a differently-named env var at the same Secret key.

const crypto = require('crypto');

class SecretWiring {
  constructor() {
    // variable name in compose -> { secretKey, value }
    this.credentials = new Map();
    // The two primary services keep their own lists; an additional service
    // carries its own on its ServiceEntry.
    this.api = { forcedKeys: new Set(), mappings: [] };
    this.frontend = { forcedKeys: new Set(), mappings: [] };
  }

  // First registration wins: the owner naming the credential (the database
  // declaring POSTGRES_PASSWORD) is discovered before its consumers, and a
  // later consumer must not rename what everything else is already wired to.
  registerCredential(varName, secretKeyName) {
    if (this.credentials.has(varName)) return this.credentials.get(varName);
    const entry = { secretKey: secretKeyName, value: crypto.randomBytes(16).toString('hex') };
    this.credentials.set(varName, entry);
    return entry;
  }

  has(varName) { return this.credentials.has(varName); }
  get(varName) { return this.credentials.get(varName); }
  entries() { return this.credentials.values(); }

  // The rule, in one place. `target` is this.api, this.frontend, or a
  // ServiceEntry - anything carrying forcedSecretKeys/extraSecretEnvMappings.
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

// Every Secret key some workload actually mounts, derived the same way the
// templates derive it.
//
// The counterpart to "is this key something CI provides?": a key CI passes
// that NOTHING reads is not harmless. It is a secret the operator was told to
// create, which does nothing - and, more to the point, it is what a
// half-applied change looks like. A key added to the workflow but never wired
// into a workload reaches the cluster's Secret and never reaches a pod, which
// from the outside is indistinguishable from the secret "not working".
//
// The dashboard's own key is included because dashboard.yaml mounts it, and a
// database password because the database template and the api's dedicated
// block both do - neither goes through a secretKeys list.
function mountedSecretKeys(config) {
  const keys = new Set();
  const add = (key) => { if (key) keys.add(key); };
  const addAll = (list) => { for (const k of list || []) add(k); };
  const addMappings = (list) => { for (const m of list || []) add(m.secretKey); };

  // Flarops' own dashboard.
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

// Keys CI is told to pass that no workload reads.
function unmountedSecretKeys(config) {
  const mounted = mountedSecretKeys(config);
  return (config.envKeysToPass || []).filter(key => key && !mounted.has(key));
}

module.exports = { SecretWiring, mountedSecretKeys, unmountedSecretKeys };
