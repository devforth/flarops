// `flarops sync`: apply flarops.yaml to the generated deployment. A merge over the state init
// recorded (deploy/.flarops-state.json), not a regeneration; where they disagree, flarops.yaml wins.

const fs = require('fs');
const path = require('path');

const { parse, YamlError } = require('../../utils/yamlLite.js');
const { readState, writeState, STATE_FILE } = require('../../utils/state.js');
const { makeServiceEntry } = require('../../utils/analyzer.js');
const { normalizeRoutes } = require('../../utils/routes.js');
const { unmountedSecretKeys } = require('../../utils/secretWiring.js');
const { validateDeclarations, validateRepositorySettings, validateSyncLock } = require('../../utils/flaropsValidate.js');
const { isDockerHub } = require('../../utils/registry.js');
const { defaultUserFor, defaultImageFor, defaultPortFor } = require('../../utils/dbDefaults.js');
const { renderChartTemplates, ChartConflict } = require('../../templates/chart.js');
const renderValues = require('../../templates/values.yaml.js');
const renderWerf = require('../../templates/werf.yaml.js');
const renderDeployWorkflow = require('../../templates/deploy.yml.js');
const renderPrCapsuleWorkflow = require('../../templates/pr-capsule.yml.js');

// Defaults a newly declared service starts from before the author's values are laid over them.
const SERVICE_DEFAULTS = Object.freeze({
  replicas: 1,
  ports: [80],
  env: {},
  secretEnvs: {},
  exposedRoutes: [],
  volumes: [],
  healthRoute: null,
  healthPort: null,
  command: null,
  buildArgs: [],
  oneShot: false,
  image: null,
  dockerfile: null,
  context: null,
  db: null,
});

const PRIMARY = new Set(['api', 'frontend', 'database']);

const ALWAYS_PRESENT = new Set([
  '_helpers.tpl', '01-ingress.yaml', 'secret.yaml', 'registry-secret.yaml', 'dashboard.yaml',
]);

// Not a service: the image repository settings at the top of flarops.yaml.
const REPOSITORY_SETTINGS = 'repositorySettings';
// Not a service either: the files sync must leave as they are.
const SYNC_LOCK = 'syncLock';

// Reads flarops.yaml once: the services, the repository settings and the locked files.
function readFlaropsYaml(text) {
  const doc = parse(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new YamlError('flarops.yaml must be a map of service blocks');
  }
  return {
    declared: declaredServices(doc),
    repository: declaredRepositorySettings(doc),
    locked: declaredSyncLock(doc),
  };
}

function declaredServices(doc) {
  if (typeof doc === 'string') doc = parse(doc);
  const raw = new Map();
  for (const [name, body] of Object.entries(doc)) {
    if (name === REPOSITORY_SETTINGS || name === SYNC_LOCK) continue;
    if (body !== null && typeof body !== 'object') {
      throw new YamlError(`"${name}" must be a service block, not a single value`);
    }
    if (Array.isArray(body)) {
      throw new YamlError(`"${name}" must be a service block, not a list`);
    }
    raw.set(name, body || {});
  }
  // Validated as written, before the defaults are laid over it.
  validateDeclarations(raw);
  const out = new Map();
  for (const [name, body] of raw) out.set(name, { ...SERVICE_DEFAULTS, ...body });
  return out;
}

// The repositorySettings block, or null when the file has none (written before it existed).
function declaredRepositorySettings(doc) {
  const block = doc[REPOSITORY_SETTINGS];
  if (block === undefined) return null;
  validateRepositorySettings(block);
  return block;
}

function declaredSyncLock(doc) {
  const block = doc[SYNC_LOCK];
  validateSyncLock(block);
  return new Set(Object.entries(block || {}).filter(([, locked]) => locked).map(([file]) => file));
}

// Lockable: the chart templates and the workflows. values.yaml and werf.yaml carry flarops.yaml
// itself, and the state is sync's own memory - locking those would make flarops.yaml a no-op.
const UNLOCKABLE = new Map([
  ['deploy/helm/values.yaml', 'it carries flarops.yaml\'s values into the chart'],
  ['werf.yaml', 'it carries flarops.yaml\'s images into the build'],
  ['deploy/.flarops-state.json', 'it is what sync remembers about the project'],
]);

function checkSyncLock(locked, lockable) {
  for (const file of locked) {
    if (UNLOCKABLE.has(file)) {
      throw new YamlError(`"syncLock.${file}" cannot be locked: ${UNLOCKABLE.get(file)}`);
    }
    if (!lockable.has(file)) {
      throw new YamlError(`"syncLock.${file}" is not a file sync writes - lock a chart template under deploy/helm/templates/, .github/workflows/deploy.yml or .github/workflows/pr-capsule.yml`);
    }
  }
}

// secretEnvs is "env name: Secret key"; the chart splits same-name keys from renamed ones.
function splitSecretEnvs(secretEnvs) {
  const secretKeys = [];
  const extraSecretEnvMappings = [];
  for (const [envName, secretKey] of Object.entries(secretEnvs || {})) {
    if (envName === secretKey) secretKeys.push(envName);
    else extraSecretEnvMappings.push({ envName, secretKey: String(secretKey) });
  }
  return { secretKeys, extraSecretEnvMappings };
}

function parseBuildArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const out = {};
  for (const entry of args) {
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq === -1) throw new YamlError(`build arg ${JSON.stringify(text)} must be written as KEY=value`);
    out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

function parseVolumes(volumes) {
  const out = [];
  for (const v of asList(volumes)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new YamlError('each volume must be a block with name and path');
    }
    if (!v.name || !v.path) {
      throw new YamlError(`volume ${JSON.stringify(v.name || '?')} needs both a name and a path`);
    }
    out.push({ name: String(v.name), target: String(v.path), ...(v.size ? { size: String(v.size) } : {}) });
  }
  return out;
}

// `args` is the old spelling of `buildArgs`.
function buildArgsOf(decl) {
  const declared = decl.buildArgs;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return decl.args;
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// databaseUrls: env names that get the URL of the service's database - its own db: if it has one,
// otherwise the top-level database. What init learned about each name (scheme, database, query)
// is kept.
function declaredUrlVars(config, decl, previous) {
  return asList(decl.databaseUrls).map(String).map(key => (previous || []).find(v => v.key === key) || { key });
}

function makeRecorder(changes) {
  // "absent" and "empty" are the same to every consumer; do not report them as a change.
  // Key order is not a change either.
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]));
    return v;
  };
  const normalize = (v) => {
    if (v === undefined || v === null || v === false) return null;
    if (Array.isArray(v)) return v.length === 0 ? null : sorted(v);
    if (typeof v === 'object' && Object.keys(v).length === 0) return null;
    return sorted(v);
  };
  const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  return function set(target, key, value, label) {
    if (same(target[key], value)) return;
    changes.push({ label, from: target[key], to: value });
    target[key] = value;
  };
}

// An empty value ("KEY:") is an empty string, not the text "null".
function envOf(decl) {
  const out = {};
  for (const [key, value] of Object.entries(decl.env || {})) out[key] = value === null ? '' : value;
  return out;
}

function applyPrimary(config, name, decl, set) {
  const prefix = name === 'api' ? 'api' : 'frontend';
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);
  const cap = prefix[0].toUpperCase() + prefix.slice(1);

  set(config, `${prefix}Replicas`, decl.replicas, `${name}.replicas`);
  set(config, `${prefix}Ports`, asList(decl.ports).map(Number), `${name}.ports`);
  set(config, `${prefix}Env`, envOf(decl), `${name}.env`);
  set(config, `${prefix}SecretKeys`,
    withoutDedicatedKeys(secretKeys, config.hasDbPassword ? config.dbPasswordKey : null),
    `${name}.secretEnvs (same name)`);
  set(config, `${prefix}ExtraSecretEnvMappings`, extraSecretEnvMappings, `${name}.secretEnvs (renamed)`);
  set(config, `${prefix}Command`, decl.command ? asList(decl.command).map(String) : null, `${name}.command`);
  set(config, `${prefix}BuildArgs`, parseBuildArgs(buildArgsOf(decl)), `${name}.buildArgs`);
  if (decl.dockerfile) set(config, `${prefix}Dockerfile`, String(decl.dockerfile), `${name}.dockerfile`);
  if (decl.context !== null && decl.context !== undefined) {
    set(config, prefix === 'api' ? 'backendPath' : 'frontendPath', String(decl.context), `${name}.context`);
  }
  if (prefix === 'api') {
    const urlVars = declaredUrlVars(config, decl, config.dbUrlVars);
    if (urlVars.length > 0 && !config.hasDb) {
      throw new YamlError('"api.databaseUrls" needs a database: declare a top-level database: block');
    }
    set(config, 'dbUrlVars', urlVars, 'api.databaseUrls');
    set(config, 'apiHealthRoute', decl.healthRoute, 'api.healthRoute');
    set(config, 'apiHealthPort', decl.healthPort, 'api.healthPort');
    set(config, 'apiRoutes', normalizeRoutes(asList(decl.exposedRoutes)), 'api.exposedRoutes');
  }
  set(config, `has${cap === 'Api' ? 'Backend' : 'Frontend'}`, true, `${name} present`);
}

function applyDatabase(config, decl, set) {
  set(config, 'dbReplicas', decl.replicas, 'database.replicas');
  if (decl.image) set(config.images, 'db', String(decl.image), 'database.image');
  if (decl.dockerfile) {
    set(config, 'dbHasLocalDockerfile', true, 'database.dockerfile');
    set(config, 'dbLocalDockerfile', String(decl.dockerfile), 'database.dockerfile');
    set(config, 'dbContext', decl.context === null || decl.context === undefined ? '.' : String(decl.context), 'database.context');
  } else if (decl.image) {
    set(config, 'dbHasLocalDockerfile', false, 'database.image');
  }
  if (decl.type) set(config, 'dbType', String(decl.type).toLowerCase(), 'database.type');
  if (decl.port) set(config, 'dbPort', Number(decl.port), 'database.port');
  if (decl.user) set(config, 'dbUser', String(decl.user), 'database.user');
  if (decl.name) set(config, 'dbName', String(decl.name), 'database.name');
  set(config, 'dbCommand', decl.command ? asList(decl.command).map(String) : null, 'database.command');
  // Every env name a database image reads its password under points at one Secret key, which is
  // all the chart needs. A second distinct key cannot be mounted; unmountedSecretKeys reports it.
  const distinctKeys = [...new Set(Object.values(decl.secretEnvs || {}).map(String))];
  if (distinctKeys.length > 0) set(config, 'dbPasswordKey', distinctKeys[0], 'database.secretEnvs');
}

function newService(name, decl) {
  return makeServiceEntry({
    name,
    originalName: name,
    composeName: name,
    relativePath: decl.context ? String(decl.context) : '.',
    dockerfile: decl.dockerfile ? String(decl.dockerfile) : 'Dockerfile',
    ports: asList(decl.ports).map(Number),
    healthRoute: decl.healthRoute,
    healthPort: decl.healthPort,
    usedEnvVars: [],
    isMavenReactorModule: false,
    exposedRoutes: normalizeRoutes(asList(decl.exposedRoutes)),
  });
}

// A db: block is the service's own database, built from what it declares and the engine's defaults.
function ownDatabaseOf(name, declDb, previous) {
  const type = String(declDb.type).toLowerCase();
  const db = {
    type,
    image: declDb.image ? String(declDb.image) : defaultImageFor(type),
    port: Number(declDb.port || defaultPortFor(type)),
    user: declDb.user ? String(declDb.user) : defaultUserFor(type),
    name: declDb.name ? String(declDb.name) : `${name}db`,
    passwordKey: String(Object.values(declDb.secretEnvs)[0]),
  };
  if (declDb.replicas !== null && declDb.replicas !== undefined) db.replicas = declDb.replicas;
  if (declDb.command) db.command = asList(declDb.command).map(String);
  if (previous && previous.composeServiceName) db.composeServiceName = previous.composeServiceName;
  return db;
}

function applyService(service, decl, set, label, notes) {
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);
  set(service, 'replicas', decl.replicas, `${label}.replicas`);
  set(service, 'ports', asList(decl.ports).map(Number), `${label}.ports`);
  set(service, 'env', envOf(decl), `${label}.env`);
  set(service, 'secretKeys',
    withoutDedicatedKeys(secretKeys, service.dbPasswordKey, service.springDatasourcePasswordSecretKey),
    `${label}.secretEnvs (same name)`);
  set(service, 'extraSecretEnvMappings', extraSecretEnvMappings, `${label}.secretEnvs (renamed)`);
  set(service, 'exposedRoutes', normalizeRoutes(asList(decl.exposedRoutes)), `${label}.exposedRoutes`);
  set(service, 'volumes', parseVolumes(decl.volumes), `${label}.volumes`);
  set(service, 'oneShot', !!decl.oneShot, `${label}.oneShot`);
  set(service, 'healthRoute', decl.healthRoute, `${label}.healthRoute`);
  set(service, 'healthPort', decl.healthPort, `${label}.healthPort`);
  set(service, 'command', decl.command ? asList(decl.command).map(String) : null, `${label}.command`);
  set(service, 'buildArgs', parseBuildArgs(buildArgsOf(decl)), `${label}.buildArgs`);
  if (decl.dockerfile) set(service, 'dockerfile', String(decl.dockerfile), `${label}.dockerfile`);
  if (decl.context !== null && decl.context !== undefined) {
    set(service, 'relativePath', String(decl.context), `${label}.context`);
  }
  if (decl.image) set(service, 'image', String(decl.image), `${label}.image`);

  const previousOwn = service.db && !service.db.shared ? service.db : null;
  if (decl.db) {
    set(service, 'db', ownDatabaseOf(label, decl.db, previousOwn), `${label}.db`);
  } else if (previousOwn) {
    set(service, 'db', null, `${label}.db removed`);
    notes.push(`${label}'s own database is removed from the chart. Its data volume (PVC data-${label}-db-0) stays in the cluster until you delete it - "kubectl delete pvc data-${label}-db-0" once nothing needs it.`);
  }
}

// A service without a database of its own reaches the top-level one; its URLs need that database.
function applyDatabaseUrls(config, service, decl, set, label) {
  const urlVars = declaredUrlVars(config, decl, service.dbUrlVars);
  const ownDb = service.db && !service.db.shared;
  if (urlVars.length > 0 && !ownDb && !config.hasDb) {
    throw new YamlError(`"${label}.databaseUrls" needs a database: declare a top-level database: block, or a db: block for ${label}`);
  }
  set(service, 'dbUrlVars', urlVars, `${label}.databaseUrls`);
  if (ownDb) return;
  if (urlVars.length === 0) {
    if (service.db) set(service, 'db', null, `${label}.databaseUrls`);
    return;
  }
  // Read from the top-level database on every sync, so a change there reaches the URL too.
  const shared = {
    ...(service.db || { name: null }),
    type: config.dbType,
    image: config.images && config.images.db,
    port: config.dbPort,
    user: config.dbUser || defaultUserFor(config.dbType),
    passwordKey: config.dbPasswordKey,
    shared: true,
  };
  set(service, 'db', shared, `${label}.databaseUrls (top-level database)`);
}

// Older state has no replica counts; absent means the default, or every sync would report changes.
function normalizeState(config) {
  config.apiReplicas = config.apiReplicas ?? SERVICE_DEFAULTS.replicas;
  config.frontendReplicas = config.frontendReplicas ?? SERVICE_DEFAULTS.replicas;
  config.dbReplicas = config.dbReplicas ?? SERVICE_DEFAULTS.replicas;
  if (config.dbType) config.dbType = String(config.dbType).toLowerCase();
  for (const service of [...(config.additionalServices || []), ...(config.supportServices || [])]) {
    service.replicas = service.replicas ?? SERVICE_DEFAULTS.replicas;
    // init records the repository root as "", flarops.yaml spells it ".".
    if (service.relativePath === '') service.relativePath = '.';
    // A URL naming the database it was built for follows that database when it is renamed; only a
    // different database on the same server keeps its own name.
    const dbName = service.db ? (service.db.shared ? config.dbName : service.db.name) : null;
    for (const v of service.dbUrlVars || []) {
      if (v.dbName && v.dbName === dbName) delete v.dbName;
    }
  }
}

function withoutDedicatedKeys(secretKeys, ...dedicated) {
  const owned = new Set(dedicated.filter(Boolean));
  return secretKeys.filter(k => !owned.has(k));
}

// The GitHub Secrets CI must pass, derived from flarops.yaml. A declared key missing here is a
// secretKeyRef to nothing. DASHBOARD_PASSWORD_HASH is Flarops' own and always passed.
const ALWAYS_PASSED = ['DASHBOARD_PASSWORD_HASH'];

function secretKeysFor(declared, config) {
  const keys = [];
  const add = (key) => { if (key && !keys.includes(key)) keys.push(key); };

  for (const decl of declared.values()) {
    for (const secretKey of Object.values(decl.secretEnvs || {})) add(String(secretKey));
    for (const secretKey of Object.values((decl.db || {}).secretEnvs || {})) add(String(secretKey));
  }
  if (config.hasDb) add(config.dbPasswordKey);
  for (const key of ALWAYS_PASSED) add(key);

  // Keep the existing order so an unchanged sync produces no diff in the workflows.
  const previous = config.envKeysToPass || [];
  const kept = previous.filter(k => keys.includes(k));
  return [...kept, ...keys.filter(k => !kept.includes(k))];
}

function applyDeclarations(state, declared, repository = null) {
  const changes = [];
  const notes = [];
  const set = makeRecorder(changes);
  const config = state;
  normalizeState(config);

  if (repository) {
    if (repository.registry !== undefined) {
      const host = String(repository.registry).toLowerCase();
      const value = isDockerHub(host) ? '' : host;
      if ((config.dockerRegistry || '') !== value) {
        changes.push({ label: 'repositorySettings.registry', from: config.dockerRegistry || 'docker.io', to: value || 'docker.io' });
        config.dockerRegistry = value;
      }
    }
    if (repository.project !== undefined) {
      set(config, 'dockerProject', repository.project === null ? null : String(repository.project), 'repositorySettings.project');
    }
    if (repository.repository !== undefined) {
      set(config, 'dockerRepository', String(repository.repository), 'repositorySettings.repository');
    }
  }

  // What exists is settled first, so no block depends on where it sits in the file.
  if (!declared.has('api')) set(config, 'hasBackend', false, 'api removed');
  if (!declared.has('frontend')) set(config, 'hasFrontend', false, 'frontend removed');
  if (declared.has('database')) {
    set(config, 'hasDb', true, 'database present');
    applyDatabase(config, declared.get('database'), set);
  } else {
    set(config, 'hasDb', false, 'database removed');
    set(config, 'dbType', null, 'database removed');
  }

  const seenAdditional = new Set();
  const seenSupport = new Set();

  for (const [name, decl] of declared) {
    if (name === 'database') continue;
    if (name === 'api' || name === 'frontend') { applyPrimary(config, name, decl, set); continue; }

    const isBuilt = !!decl.dockerfile;
    const list = isBuilt ? (config.additionalServices ||= []) : (config.supportServices ||= []);
    (isBuilt ? seenAdditional : seenSupport).add(name);

    let service = list.find(s => s.name === name);
    if (!service) {
      service = isBuilt ? newService(name, decl) : { name, image: null, env: {}, secretKeys: [], extraSecretEnvMappings: [], ports: [], volumes: [] };
      list.push(service);
      changes.push({ label: `${name}: created from the shared template`, from: null, to: name });
    }
    applyService(service, decl, set, name, notes);
    if (isBuilt) applyDatabaseUrls(config, service, decl, set, name);
  }

  // A service removed from flarops.yaml is removed from the deployment.
  for (const key of ['additionalServices', 'supportServices']) {
    const seen = key === 'additionalServices' ? seenAdditional : seenSupport;
    const before = config[key] || [];
    const after = before.filter(s => seen.has(s.name));
    for (const s of before) {
      if (!seen.has(s.name)) changes.push({ label: `${s.name}: no longer declared, removed`, from: s.name, to: null });
    }
    config[key] = after;
  }
  const secretKeys = secretKeysFor(declared, config);
  const before = config.envKeysToPass || [];
  const added = secretKeys.filter(k => !before.includes(k));
  const removed = before.filter(k => !secretKeys.includes(k));
  if (added.length > 0 || removed.length > 0) {
    for (const key of added) changes.push({ label: `GitHub Secret ${key}: now required by the chart`, from: null, to: key });
    for (const key of removed) changes.push({ label: `GitHub Secret ${key}: no longer referenced`, from: key, to: null });
    config.envKeysToPass = secretKeys;
  }

  return { config, changes, notes };
}

function expectedTemplateNames(config, templatesDir) {
  return new Set(renderChartTemplates(config, templatesDir).map(t => path.basename(t.file)));
}

function findOrphanTemplates(currentDir) {
  const templatesDir = path.join(currentDir, 'deploy', 'helm', 'templates');
  if (!fs.existsSync(templatesDir)) return null;
  let state;
  try { state = readState(currentDir); } catch (e) { return null; }
  if (!state) return null;

  const expected = expectedTemplateNames(state, templatesDir);
  for (const name of ALWAYS_PRESENT) expected.add(name);
  const present = fs.readdirSync(templatesDir).filter(f => /\.(yaml|tpl)$/.test(f));
  return { templatesDir, orphans: present.filter(f => !expected.has(f)) };
}

function describe(value) {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

module.exports = async function sync() {
  const currentDir = process.cwd();
  const flaropsYamlFile = path.join(currentDir, 'flarops.yaml');
  const helmDir = path.join(currentDir, 'deploy', 'helm');
  const templatesDir = path.join(helmDir, 'templates');

  if (!fs.existsSync(flaropsYamlFile)) {
    console.error('\x1b[31mERROR: no flarops.yaml here. Run "flarops init" first - sync applies that file, it cannot invent it.\x1b[0m');
    process.exit(1);
  }

  let state;
  try {
    state = readState(currentDir);
  } catch (e) {
    console.error(`\x1b[31mERROR: ${e.message}\x1b[0m`);
    console.error(`  ${STATE_FILE} records what init worked out by reading this repository. Restore it from git rather than deleting it - regenerating it means re-running init, which issues a new deploy key and dashboard password.`);
    process.exit(1);
  }
  if (!state) {
    console.error(`\x1b[31mERROR: ${STATE_FILE} is missing, so there is no deployment to apply flarops.yaml to.\x1b[0m`);
    console.error('  It is written by "flarops init" and is meant to be committed. If this project was generated by an older version, re-run init in a fresh checkout to produce it.');
    process.exit(1);
  }

  let declared;
  let repository = null;
  let locked = new Set();
  try {
    ({ declared, repository, locked } = readFlaropsYaml(fs.readFileSync(flaropsYamlFile, 'utf8')));
  } catch (e) {
    if (e instanceof YamlError) {
      console.error(`\x1b[31mERROR: flarops.yaml could not be read - ${e.message}\x1b[0m`);
      process.exit(1);
    }
    throw e;
  }

  if (declared.size === 0) {
    console.error('\x1b[31mERROR: flarops.yaml declares no services. Refusing to tear down the whole deployment on what looks like an empty or truncated file.\x1b[0m');
    process.exit(1);
  }

  // What the previous sync rendered: which files sync owns, and what a locked file would have become.
  const previousState = JSON.parse(JSON.stringify(state));
  normalizeState(previousState);
  let previousRender = null;
  try {
    previousRender = new Map([
      ...renderChartTemplates(previousState, templatesDir).map(t => [t.file, t.content]),
      [path.join(currentDir, '.github', 'workflows', 'deploy.yml'), renderDeployWorkflow(previousState)],
      [path.join(currentDir, '.github', 'workflows', 'pr-capsule.yml'), renderPrCapsuleWorkflow(previousState)],
    ]);
  } catch (e) {
    console.warn(`\x1b[33mWARNING: the recorded state could not be rendered (${e.message}), so sync cannot tell which templates it generated before - none are removed this time.\x1b[0m`);
  }

  let config, changes, notes, valuesYaml, templates, werfYaml, workflows;
  const context = { hasLocalhostWarnings: false };
  try {
    ({ config, changes, notes } = applyDeclarations(state, declared, repository));
    // Render everything first, so a template that throws leaves nothing half-written.
    valuesYaml = renderValues(config, context);
    templates = renderChartTemplates(config, templatesDir);
    werfYaml = renderWerf(config);
    workflows = [
      { file: path.join(currentDir, '.github', 'workflows', 'deploy.yml'), content: renderDeployWorkflow(config) },
      { file: path.join(currentDir, '.github', 'workflows', 'pr-capsule.yml'), content: renderPrCapsuleWorkflow(config) },
    ].filter(w => fs.existsSync(path.dirname(w.file)));
  } catch (e) {
    if (e instanceof YamlError || e instanceof ChartConflict) {
      console.error(`\x1b[31mERROR: flarops.yaml cannot be applied - ${e.message}\x1b[0m`);
      process.exit(1);
    }
    throw e;
  }

  const relative = (file) => path.relative(currentDir, file).split(path.sep).join('/');
  const present = fs.existsSync(templatesDir) ? fs.readdirSync(templatesDir).filter(f => /\.(yaml|tpl)$/.test(f)) : [];
  try {
    checkSyncLock(locked, new Set([...templates, ...workflows].map(t => relative(t.file))
      .concat(present.map(f => relative(path.join(templatesDir, f))))));
  } catch (e) {
    if (e instanceof YamlError) {
      console.error(`\x1b[31mERROR: flarops.yaml cannot be applied - ${e.message}\x1b[0m`);
      process.exit(1);
    }
    throw e;
  }

  // Checked before the no-change shortcut: a deployment can match flarops.yaml and still mount nothing for a key.
  const unmounted = unmountedSecretKeys(config);
  if (unmounted.length > 0) {
    console.warn(`\x1b[33mWARNING: CI passes these Secret keys but no workload reads them: ${unmounted.join(', ')}. They reach the cluster's Secret and no container - which looks exactly like the secret not working. Declare each under the secretEnvs of the service that needs it in flarops.yaml and run sync again, or remove it if nothing needs it.\x1b[0m`);
  }

  // Only templates sync generated itself are removed; a file added by hand is left alone.
  const expected = new Set([...templates.map(t => path.basename(t.file)), ...ALWAYS_PRESENT]);
  const ownedBefore = previousRender
    ? new Set([...[...previousRender.keys()].map(f => path.basename(f)), ...ALWAYS_PRESENT])
    : new Set();
  const orphans = present.filter(f => ownedBefore.has(f) && !expected.has(f));
  const lockedOrphans = orphans.filter(f => locked.has(relative(path.join(templatesDir, f))));
  if (lockedOrphans.length > 0) {
    console.error(`\x1b[31mERROR: ${lockedOrphans.map(f => relative(path.join(templatesDir, f))).join(', ')} belong to services flarops.yaml no longer declares, but syncLock keeps them - Helm would go on deploying those services. Remove them from syncLock, or delete the files yourself.\x1b[0m`);
    process.exit(1);
  }

  const outputs = [
    { file: path.join(helmDir, 'values.yaml'), content: valuesYaml },
    ...templates,
    { file: path.join(currentDir, 'werf.yaml'), content: werfYaml },
    ...workflows,
  ];
  // Line endings are not a difference: a checkout with autocrlf would otherwise be rewritten each time.
  const differs = (o) => !fs.existsSync(o.file) || fs.readFileSync(o.file, 'utf8').replace(/\r\n/g, '\n') !== o.content;
  const toWrite = outputs.filter(o => !locked.has(relative(o.file)) && differs(o));
  // A locked file is reported only when what sync renders for it changed - not merely because it was edited.
  const heldBack = outputs
    .filter(o => locked.has(relative(o.file)))
    .filter(o => (previousRender && previousRender.has(o.file) ? previousRender.get(o.file) !== o.content : differs(o)))
    .map(o => relative(o.file));

  if (changes.length === 0 && toWrite.length === 0 && orphans.length === 0) {
    console.log('Deployment already matches flarops.yaml - nothing to do.');
    if (heldBack.length > 0) {
      console.warn(`\x1b[33mWARNING: syncLock kept these files as they are, so what changed in them did not reach them: ${heldBack.join(', ')}.\x1b[0m`);
    }
    return;
  }

  if (changes.length > 0) {
    console.log('Applying flarops.yaml:');
    for (const c of changes) {
      if (c.from === null && c.to !== null && /created|removed/.test(c.label)) console.log(`  ${c.label}`);
      else console.log(`  ${c.label}: ${describe(c.from)} -> ${describe(c.to)}`);
    }
  } else {
    console.log('flarops.yaml is unchanged; these files are rewritten from this version of Flarops\' templates:');
    for (const o of toWrite) console.log(`  ${relative(o.file)}`);
  }
  console.log('');

  for (const o of toWrite) fs.writeFileSync(o.file, o.content);
  writeState(currentDir, config);

  for (const f of orphans) fs.unlinkSync(path.join(templatesDir, f));
  if (orphans.length > 0) {
    console.log(`Removed ${orphans.length} template(s) for services flarops.yaml no longer declares: ${orphans.join(', ')}`);
  }

  for (const note of notes) console.warn(`\x1b[33mNOTE: ${note}\x1b[0m`);

  const needed = new Set();
  for (const decl of declared.values()) {
    for (const key of Object.values(decl.secretEnvs || {})) needed.add(String(key));
    for (const key of Object.values((decl.db || {}).secretEnvs || {})) needed.add(String(key));
  }
  const workflow = path.join(currentDir, '.github', 'workflows', 'deploy.yml');
  if (fs.existsSync(workflow)) {
    const text = fs.readFileSync(workflow, 'utf8');
    const missing = [...needed].filter(k => !text.includes(`SECRET_ENV_${k}:`) && !text.includes(`secrets.${k} `));
    if (missing.length > 0) {
      console.warn(`\x1b[33mWARNING: these Secret keys are now referenced by the chart but not passed by .github/workflows/deploy.yml: ${missing.join(', ')}. Add a "SECRET_ENV_<KEY>: \${{ secrets.<KEY> }}" line for each under the deploy step's env:, and add the secret to the repository - without it those pods stay in CreateContainerConfigError.\x1b[0m`);
    }
  }

  if (context.hasLocalhostWarnings) {
    console.warn('\x1b[33mWARNING: some values still point at localhost, which inside a cluster reaches the pod itself. Change them to the service name in flarops.yaml.\x1b[0m');
  }

  console.log('\x1b[32mdeploy/helm, werf.yaml and the recorded state now match flarops.yaml.\x1b[0m');
  console.log('Review the diff, commit it, and redeploy.');

  if (heldBack.length > 0) {
    console.warn(`\x1b[33mWARNING: syncLock kept these files as they are, so the changes above did not reach them: ${heldBack.join(', ')}. Carry what they need over by hand, or remove them from syncLock and run sync again.\x1b[0m`);
  }
};

module.exports.findOrphanTemplates = findOrphanTemplates;
module.exports.applyDeclarations = applyDeclarations;
module.exports.declaredServices = declaredServices;
module.exports.normalizeState = normalizeState;
