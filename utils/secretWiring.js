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

module.exports = { SecretWiring };
