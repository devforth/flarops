// `flarops sync`: apply flarops.yaml to the generated deployment. A merge over the state init
// recorded (deploy/.flarops-state.json), not a regeneration; where they disagree, flarops.yaml wins.

const fs = require('fs');
const path = require('path');

const { parse, YamlError } = require('../../utils/yamlLite.js');
const { readState, writeState, contentHash, STATE_FILE } = require('../../utils/state.js');
const { safeWriteFile, safeUnlink, assertNoSymlink, SymlinkError } = require('../../utils/safeWrite.js');
const { makeServiceEntry } = require('../../utils/analyzer.js');
const { normalizeRoutes } = require('../../utils/routes.js');
const { unmountedSecretKeys } = require('../../utils/secretWiring.js');
const { validateDeclarations, validateRepositorySettings, validateSyncLock, suspiciousSecretNames } = require('../../utils/flaropsValidate.js');
const { isDockerHub, imageRepository } = require('../../utils/registry.js');
const { defaultUserFor, defaultImageFor, defaultPortFor, databaseVolumes } = require('../../utils/dbDefaults.js');
const { claimNameFor } = require('../../templates/generic/volumes.js');
const { renderChartTemplates, ChartConflict } = require('../../templates/chart.js');
const renderValues = require('../../templates/values.yaml.js');
const renderWerf = require('../../templates/werf.yaml.js');
const renderDeployWorkflow = require('../../templates/deploy.yml.js');
const renderPrCapsuleWorkflow = require('../../templates/pr-capsule.yml.js');
const { AGENTS_BLOCK, withBlock, hasBlock } = require('../../utils/agentsDoc.js');
const { renderDashboardFiles } = require('../../utils/dashboardFiles.js');
const { formatChanges, secretReaders, dataNotes } = require('../../utils/syncReport.js');
const { enterProjectRoot } = require('../../utils/projectRoot.js');

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

// What init names the top-level database when it finds no name.
const DEFAULT_DB_NAME = 'appdb';

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

// What a volume change means for data already on disk: a removed volume's claim stays (Helm keeps it,
// as a StatefulSet does), and a new size does not reach a claim that exists - local-path cannot grow
// one, and a StatefulSet's claim templates cannot change at all.
function volumeNotes(label, before, after, claimOf, { statefulSet = false } = {}, notes) {
  const prev = new Map((before || []).map(v => [v.name, v]));
  const next = new Map((after || []).map(v => [v.name, v]));
  for (const [name] of prev) {
    if (!next.has(name)) {
      notes.push(`${label}: volume "${name}" is no longer declared. Its claim ${claimOf(name)} and the data on it stay in the cluster - "kubectl delete pvc ${claimOf(name)}" once nothing needs it.`);
    }
  }
  for (const [name, v] of next) {
    const was = prev.get(name);
    if (was && (was.size || '') !== (v.size || '')) {
      notes.push(statefulSet
        ? `${label}: volume "${name}" changed size (${was.size || 'default'} -> ${v.size || 'default'}). A deployed StatefulSet cannot change its claims, so the next deploy fails until you move the data: dump it, delete the StatefulSet and the claim ${claimOf(name)}, deploy, restore.`
        : `${label}: volume "${name}" changed size (${was.size || 'default'} -> ${v.size || 'default'}). That applies to a new claim only - an existing ${claimOf(name)} keeps its size (local-path storage cannot grow one); move the data to a new claim to resize it.`);
    }
    if (was && was.target !== v.target) {
      notes.push(`${label}: volume "${name}" is now mounted at ${v.target} (was ${was.target}). The data on it stays where it is on the disk; the container sees it at the new path.`);
    }
  }
}

function replicaNote(label, replicas, volumes, notes) {
  if ((replicas ?? 1) > 1 && (volumes || []).length > 0) {
    notes.push(`${label}: ${replicas} replicas share ReadWriteOnce volumes, which only pods on one node can mount - replicas the scheduler puts on another node stay Pending.`);
  }
}

// An empty value ("KEY:") is an empty string, not the text "null".
function envOf(decl) {
  const out = {};
  for (const [key, value] of Object.entries(decl.env || {})) out[key] = value === null ? '' : value;
  return out;
}

// secretEnvs as flarops.yaml has them: the keys a block lists, wherever the chart mounts each - its
// own block for a database password, or the shared list. The report compares these, so moving a
// key from one to the other is not a change.
function declaredSecretView(sameName, mappings, dedicated = []) {
  const same = new Set((sameName || []).map(String));
  const renamed = new Map((mappings || []).map(m => [m.envName, m.secretKey]));
  for (const d of dedicated) {
    if (d.envName === d.secretKey) same.add(d.envName);
    else renamed.set(d.envName, d.secretKey);
  }
  return {
    same: [...same].sort(),
    renamed: [...renamed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([envName, secretKey]) => ({ envName, secretKey })),
  };
}

function recordSecretEnvs(set, label, before, after) {
  set({ v: before.same }, 'v', after.same, `${label}.secretEnvs (same name)`);
  set({ v: before.renamed }, 'v', after.renamed, `${label}.secretEnvs (renamed)`);
}

// `before`: the database password key and whether the api had it in a block of its own, as they
// were before this sync.
function applyPrimary(config, name, decl, set, notes, before) {
  const prefix = name === 'api' ? 'api' : 'frontend';
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);

  set(config, `${prefix}Replicas`, decl.replicas, `${name}.replicas`);
  set(config, `${prefix}Ports`, asList(decl.ports).map(Number), `${name}.ports`);
  set(config, `${prefix}Env`, envOf(decl), `${name}.env`);
  if (prefix === 'api') {
    // The api gets the database password in a block of its own only while api.secretEnvs lists it.
    const dbKey = config.hasDb && config.dbPasswordKey ? config.dbPasswordKey : null;
    const dedicated = !!dbKey && secretKeys.includes(dbKey);
    const had = before.apiDbPassword && before.dbPasswordKey ? [{ envName: before.dbPasswordKey, secretKey: before.dbPasswordKey }] : [];
    recordSecretEnvs(set, name,
      declaredSecretView(config.apiSecretKeys, config.apiExtraSecretEnvMappings, had),
      declaredSecretView(secretKeys, extraSecretEnvMappings));
    config.apiSecretKeys = withoutDedicatedKeys(secretKeys, dedicated ? dbKey : null);
    config.apiExtraSecretEnvMappings = extraSecretEnvMappings;
    config.apiDbPassword = dedicated;
  } else {
    recordSecretEnvs(set, name,
      declaredSecretView(config.frontendSecretKeys, config.frontendExtraSecretEnvMappings),
      declaredSecretView(secretKeys, extraSecretEnvMappings));
    config.frontendSecretKeys = secretKeys;
    config.frontendExtraSecretEnvMappings = extraSecretEnvMappings;
  }
  set(config, `${prefix}Command`, decl.command ? asList(decl.command).map(String) : null, `${name}.command`);
  set(config, `${prefix}BuildArgs`, parseBuildArgs(buildArgsOf(decl)), `${name}.buildArgs`);
  const volumes = parseVolumes(decl.volumes);
  volumeNotes(name, config[`${prefix}Volumes`], volumes, (v) => claimNameFor(name, v), {}, notes);
  set(config, `${prefix}Volumes`, volumes, `${name}.volumes`);
  replicaNote(name, decl.replicas, volumes, notes);
  // A field left out is its default, not whatever it was before.
  set(config, `${prefix}Dockerfile`, decl.dockerfile ? String(decl.dockerfile) : 'Dockerfile', `${name}.dockerfile`);
  set(config, prefix === 'api' ? 'backendPath' : 'frontendPath', contextOf(decl), `${name}.context`);
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
}

// context: is the repository root when left out.
function contextOf(decl) {
  return decl.context === null || decl.context === undefined || decl.context === '' ? '.' : String(decl.context);
}

function applyDatabase(config, decl, set, notes) {
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
  // Left out, these are the engine's defaults (as in a db: block), not what they were before.
  set(config, 'dbPort', decl.port ? Number(decl.port) : defaultPortFor(config.dbType), 'database.port');
  set(config, 'dbUser', decl.user ? String(decl.user) : defaultUserFor(config.dbType), 'database.user');
  set(config, 'dbName', decl.name ? String(decl.name) : DEFAULT_DB_NAME, 'database.name');
  set(config, 'dbCommand', decl.command ? asList(decl.command).map(String) : null, 'database.command');
  const volumes = databaseVolumes(parseVolumes(decl.volumes), config.dbType, config.images && config.images.db);
  volumeNotes('database', config.dbVolumes, volumes, (v) => `${String(v).toLowerCase().replace(/[^a-z0-9-]/g, '-')}-database-0`, { statefulSet: true }, notes);
  set(config, 'dbVolumes', volumes, 'database.volumes');
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
  db.volumes = databaseVolumes(parseVolumes(declDb.volumes), type, db.image);
  if (previous && previous.composeServiceName) db.composeServiceName = previous.composeServiceName;
  return db;
}

const SPRING_PASSWORD = 'SPRING_DATASOURCE_PASSWORD';

function applyService(config, service, decl, set, label, notes) {
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);
  set(service, 'replicas', decl.replicas, `${label}.replicas`);
  set(service, 'ports', asList(decl.ports).map(Number), `${label}.ports`);
  set(service, 'env', envOf(decl), `${label}.env`);

  // A database password init gave a block of its own keeps it only while secretEnvs still lists it,
  // under the same name and, for the top-level database's, while that database and key exist.
  const dbKey = service.dbPasswordKey && config.hasDb && service.dbPasswordKey === config.dbPasswordKey
    && secretKeys.includes(service.dbPasswordKey) ? service.dbPasswordKey : null;
  const declaredSpring = decl.secretEnvs && Object.prototype.hasOwnProperty.call(decl.secretEnvs, SPRING_PASSWORD)
    ? String(decl.secretEnvs[SPRING_PASSWORD]) : null;
  const springKey = service.springDatasourcePasswordSecretKey && declaredSpring ? declaredSpring : null;
  const had = [
    ...(service.dbPasswordKey ? [{ envName: service.dbPasswordKey, secretKey: service.dbPasswordKey }] : []),
    ...(service.springDatasourcePasswordSecretKey ? [{ envName: SPRING_PASSWORD, secretKey: service.springDatasourcePasswordSecretKey }] : []),
  ];
  recordSecretEnvs(set, label,
    declaredSecretView(service.secretKeys, service.extraSecretEnvMappings, had),
    declaredSecretView(secretKeys, extraSecretEnvMappings));
  service.secretKeys = withoutDedicatedKeys(secretKeys, dbKey, springKey ? SPRING_PASSWORD : null);
  service.extraSecretEnvMappings = extraSecretEnvMappings.filter(m => !(springKey && m.envName === SPRING_PASSWORD));
  service.dbPasswordKey = dbKey;
  service.springDatasourcePasswordSecretKey = springKey;
  set(service, 'exposedRoutes', normalizeRoutes(asList(decl.exposedRoutes)), `${label}.exposedRoutes`);
  const volumes = parseVolumes(decl.volumes);
  volumeNotes(label, service.volumes, volumes, (v) => claimNameFor(label, v), {}, notes);
  set(service, 'volumes', volumes, `${label}.volumes`);
  replicaNote(label, decl.replicas, volumes, notes);
  set(service, 'oneShot', !!decl.oneShot, `${label}.oneShot`);
  set(service, 'healthRoute', decl.healthRoute, `${label}.healthRoute`);
  set(service, 'healthPort', decl.healthPort, `${label}.healthPort`);
  set(service, 'command', decl.command ? asList(decl.command).map(String) : null, `${label}.command`);
  set(service, 'buildArgs', parseBuildArgs(buildArgsOf(decl)), `${label}.buildArgs`);
  if (decl.dockerfile) {
    set(service, 'dockerfile', String(decl.dockerfile), `${label}.dockerfile`);
    set(service, 'relativePath', contextOf(decl), `${label}.context`);
  }
  if (decl.image) set(service, 'image', String(decl.image), `${label}.image`);

  const previousOwn = service.db && !service.db.shared ? service.db : null;
  if (decl.db) {
    const own = ownDatabaseOf(label, decl.db, previousOwn);
    if (previousOwn) {
      volumeNotes(`${label}.db`, previousOwn.volumes, own.volumes, (v) => `${String(v).toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${label}-db-0`, { statefulSet: true }, notes);
    }
    set(service, 'db', own, `${label}.db`);
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
    if (service.db) set(service, 'db', null, `${label}.databaseUrls (top-level database)`);
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

// repositorySettings: where the images go, and the login CI pushes with.
function applyRepositorySettings(config, repository, set, changes, notes) {
  const count = changes.length;
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
  // user: left out, it is the login init asked for.
  if (repository.user !== undefined) {
    if (config.registryUserFromInit === undefined) config.registryUserFromInit = config.registryUser ?? null;
    set(config, 'registryUser', String(repository.user), 'repositorySettings.user');
  } else if (config.registryUserFromInit !== undefined) {
    set(config, 'registryUser', config.registryUserFromInit, 'repositorySettings.user');
    delete config.registryUserFromInit;
  }
  // On Docker Hub without a project the login is also the namespace, written into shell commands.
  if (repository.user !== undefined && isDockerHub(config.dockerRegistry) && !config.dockerProject && !/^[a-z0-9]+$/.test(String(repository.user))) {
    throw new YamlError(`"repositorySettings.user" must be a Docker Hub user name (lowercase letters and digits) when the images go to Docker Hub without a project, not ${JSON.stringify(String(repository.user))}`);
  }
  if (changes.slice(count).some(c => /^repositorySettings\.(registry|project|user)$/.test(c.label))) {
    notes.push(`CI now pushes to ${imageRepository(config).replace('${{ env.REGISTRY_USER }}', config.registryUser || '<REGISTRY_USER>')}, logging in as ${config.registryUser || 'REGISTRY_USER'} with the REGISTRY_PASSWORD GitHub secret. Both must belong to that registry: set repositorySettings.user to your login there if it differs, and update the secret ("gh secret set REGISTRY_PASSWORD") before you push.`);
  }
}

function applyDeclarations(state, declared, repository = null) {
  const changes = [];
  const notes = [];
  const set = makeRecorder(changes);
  const config = state;
  normalizeState(config);

  if (repository) applyRepositorySettings(config, repository, set, changes, notes);

  // A block that was not there before is reported as added, not field by field against what an
  // earlier one left in the state.
  const wasPresent = { api: !!config.hasBackend, frontend: !!config.hasFrontend, database: !!config.hasDb };
  const quiet = (target, key, value) => { target[key] = value; };
  const previous = {
    dbPasswordKey: config.dbPasswordKey,
    apiDbPassword: !!config.hasBackend && !!(config.apiDbPassword ?? config.hasDbPassword),
  };

  // What exists is settled first, so no block depends on where it sits in the file.
  if (!declared.has('api')) set(config, 'hasBackend', false, 'api removed');
  if (!declared.has('frontend')) set(config, 'hasFrontend', false, 'frontend removed');
  if (declared.has('database')) {
    set(config, 'hasDb', true, 'database present');
    applyDatabase(config, declared.get('database'), wasPresent.database ? set : quiet, wasPresent.database ? notes : []);
  } else {
    set(config, 'hasDb', false, 'database removed');
    set(config, 'dbType', null, 'database removed');
  }
  // CI hands the database password to the chart (for its checksum) while there is a database.
  config.hasDbPassword = !!(config.hasDb && config.dbPasswordKey);

  const seenAdditional = new Set();
  const seenSupport = new Set();

  for (const [name, decl] of declared) {
    if (name === 'database') continue;
    if (name === 'api' || name === 'frontend') {
      applyPrimary(config, name, decl, wasPresent[name] ? set : quiet, wasPresent[name] ? notes : [], previous);
      set(config, name === 'api' ? 'hasBackend' : 'hasFrontend', true, `${name} present`);
      continue;
    }

    const isBuilt = !!decl.dockerfile;
    const list = isBuilt ? (config.additionalServices ||= []) : (config.supportServices ||= []);
    (isBuilt ? seenAdditional : seenSupport).add(name);

    let service = list.find(s => s.name === name);
    if (!service) {
      service = isBuilt ? newService(name, decl) : { name, image: null, env: {}, secretKeys: [], extraSecretEnvMappings: [], ports: [], volumes: [] };
      list.push(service);
      changes.push({ label: `${name}: created from the shared template`, from: null, to: name });
    }
    applyService(config, service, decl, set, name, notes);
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

// The line of flarops.yaml a field path ("api.secretEnvs.STRIPE_KEY", "api.ports[1]") is on: each
// part is looked up among the keys one level below the previous one, and [i] among the items of a
// sequence. The deepest part found wins; null if none is.
function lineOf(text, where) {
  const lines = text.split('\n');
  const indentOf = (l) => l.length - l.trimStart().length;
  const blank = (l) => !l.trim() || l.trim().startsWith('#');
  const isItem = (l) => /^\s*-(\s|$)/.test(l);
  const keyOf = (l) => {
    const m = l.trim().replace(/^-\s+/, '').match(/^(["']?)([^"':]+)\1\s*:(\s|$)/);
    return m ? m[2].trim() : null;
  };
  const firstLine = (from, to) => { for (let i = from; i < to; i++) if (!blank(lines[i])) return i; return -1; };
  let from = 0;
  let to = lines.length;
  let rest = where;
  let found = null;
  while (rest) {
    const item = rest.match(/^\[(\d+)\]\.?/);
    if (item) {
      // The n-th "- " entry of the sequence below the line found last.
      const first = firstLine(from, to);
      if (first === -1 || !isItem(lines[first])) break;
      const indent = indentOf(lines[first]);
      const starts = [];
      for (let i = first; i < to; i++) if (!blank(lines[i]) && indentOf(lines[i]) === indent && isItem(lines[i])) starts.push(i);
      const at = starts[Number(item[1])];
      if (at === undefined) break;
      found = at + 1;
      rest = rest.slice(item[0].length);
      // The entry's first key is on its "- " line: read that line as if the dash were a space.
      lines[at] = lines[at].replace(/^(\s*)-/, '$1 ');
      from = at;
      to = starts.find(i => i > at) ?? to;
      continue;
    }
    let childIndent = null;
    let match = null;
    for (let i = from; i < to; i++) {
      const l = lines[i];
      if (blank(l)) continue;
      if (childIndent === null) childIndent = indentOf(l);
      if (indentOf(l) !== childIndent) continue;
      const key = keyOf(l);
      if (key && (rest === key || rest.startsWith(`${key}.`) || rest.startsWith(`${key}[`)) && (!match || key.length > match.key.length)) match = { i, key };
    }
    if (!match) break;
    found = match.i + 1;
    rest = rest.slice(match.key.length).replace(/^\./, '');
    from = match.i + 1;
    let end = from;
    while (end < to && (blank(lines[end]) || indentOf(lines[end]) > childIndent)) end++;
    // A sequence may sit at its key's own indent.
    const next = firstLine(from, to);
    if (firstLine(from, end) === -1 && next !== -1 && indentOf(lines[next]) === childIndent && isItem(lines[next])) {
      end = next;
      while (end < to && (blank(lines[end]) || indentOf(lines[end]) > childIndent || (indentOf(lines[end]) === childIndent && isItem(lines[end])))) end++;
    }
    to = end;
  }
  return found;
}

// An error in flarops.yaml, with its line when the parser did not give one, and that nothing changed.
function reportYamlError(e, text) {
  let message = e.message;
  const where = !e.line && (message.match(/^"([^"]+)"/) || [])[1];
  const line = where ? lineOf(text, where) : null;
  if (line) message = `line ${line}: ${message}`;
  console.error(`\x1b[31mERROR in flarops.yaml, ${message}\x1b[0m`);
  console.error('Nothing was written. Fix that and run sync again.');
  process.exit(1);
}

module.exports = async function sync({ check = false } = {}) {
  if (!enterProjectRoot()) {
    console.error('\x1b[31mERROR: no flarops.yaml here or in any directory above, up to the repository root. Run sync inside a project Flarops has set up; to set one up, run "npx flarops init" from its root.\x1b[0m');
    process.exit(1);
  }
  const currentDir = process.cwd();
  const flaropsYamlFile = path.join(currentDir, 'flarops.yaml');
  const helmDir = path.join(currentDir, 'deploy', 'helm');
  const templatesDir = path.join(helmDir, 'templates');

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
  const flaropsYamlText = fs.readFileSync(flaropsYamlFile, 'utf8');
  try {
    ({ declared, repository, locked } = readFlaropsYaml(flaropsYamlText));
  } catch (e) {
    if (e instanceof YamlError) reportYamlError(e, flaropsYamlText);
    throw e;
  }

  const suspicious = suspiciousSecretNames(declared);
  if (suspicious.length > 0) {
    console.warn(`\x1b[33mWARNING: these secretEnvs look like a secret's value, not its name: ${suspicious.join(', ')}. secretEnvs maps a variable to the NAME of a GitHub Secret (STRIPE_KEY: STRIPE_KEY); the value goes into the secret itself, never into this file. If one is already committed, rotate it.\x1b[0m`);
  }

  if (declared.size === 0) {
    console.error('\x1b[31mERROR: flarops.yaml declares no services. Refusing to tear down the whole deployment on what looks like an empty or truncated file.\x1b[0m');
    process.exit(1);
  }

  // The recorded state rendered by these templates: which files sync owns, and - for a state written
  // before sync recorded hashes - what each file held.
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
    if (e instanceof YamlError || e instanceof ChartConflict) reportYamlError(e, flaropsYamlText);
    throw e;
  }

  const relative = (file) => path.relative(currentDir, file).split(path.sep).join('/');
  const present = fs.existsSync(templatesDir) ? fs.readdirSync(templatesDir).filter(f => /\.(yaml|tpl)$/.test(f)) : [];
  try {
    checkSyncLock(locked, new Set([...templates, ...workflows].map(t => relative(t.file))
      .concat(present.map(f => relative(path.join(templatesDir, f))))));
  } catch (e) {
    if (e instanceof YamlError) reportYamlError(e, flaropsYamlText);
    throw e;
  }

  // Checked before the no-change shortcut: a deployment can match flarops.yaml and still mount nothing for a key.
  const unmounted = unmountedSecretKeys(config);
  if (unmounted.length > 0) {
    console.warn(`\x1b[33mWARNING: CI passes these Secret keys but no workload reads them: ${unmounted.join(', ')}. They reach the cluster's Secret and no container - which looks exactly like the secret not working. Declare each under the secretEnvs of the service that needs it in flarops.yaml and run sync again, or remove it if nothing needs it.\x1b[0m`);
  }

  // Only templates sync generated itself are removed; a file added by hand is left alone.
  const recordedHashes = previousState.fileHashes && typeof previousState.fileHashes === 'object' ? previousState.fileHashes : null;
  const expected = new Set([...templates.map(t => path.basename(t.file)), ...ALWAYS_PRESENT]);
  const ownedBefore = new Set([
    ...(previousRender ? [...previousRender.keys()].map(f => path.basename(f)) : []),
    ...Object.keys(recordedHashes || {}).filter(f => path.posix.dirname(f) === 'deploy/helm/templates').map(f => path.posix.basename(f)),
    ...(previousRender || recordedHashes ? ALWAYS_PRESENT : []),
  ]);
  const orphans = present.filter(f => ownedBefore.has(f) && !expected.has(f));
  const lockedOrphans = orphans.filter(f => locked.has(relative(path.join(templatesDir, f))));
  if (lockedOrphans.length > 0) {
    console.error(`\x1b[31mERROR: ${lockedOrphans.map(f => relative(path.join(templatesDir, f))).join(', ')} belong to services flarops.yaml no longer declares, but syncLock keeps them - Helm would go on deploying those services. Remove them from syncLock, or delete the files yourself.\x1b[0m`);
    process.exit(1);
  }

  const dashboardDir = path.join(currentDir, 'deploy', 'dashboard');
  const dashboardFiles = renderDashboardFiles(dashboardDir);
  // Files an earlier sync (or init) shipped and this version does not: a stale .go file would break
  // the build. Only those recorded are removed - anything else there is the project's own.
  const dashboardStale = [];
  if (dashboardFiles.length > 0) {
    const shipped = dashboardFiles.map(f => path.relative(dashboardDir, f.file).split(path.sep).join('/'));
    const recorded = Array.isArray(previousState.dashboardFiles) ? previousState.dashboardFiles.map(String) : [];
    for (const rel of recorded) {
      const parts = rel.split('/');
      if (shipped.includes(rel) || path.posix.isAbsolute(rel) || parts.some(p => p === '' || p === '.' || p === '..')) continue;
      const file = path.join(dashboardDir, ...parts);
      try { if (fs.lstatSync(file).isFile()) dashboardStale.push(file); } catch (e) { /* already gone */ }
    }
    config.dashboardFiles = shipped;
  }

  // The Flarops section of AGENTS.md follows this version of Flarops; the rest of the file is the project's.
  const agentsDocs = [];
  {
    const agentsFile = path.join(currentDir, 'AGENTS.md');
    const current = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : null;
    if (hasBlock(current)) agentsDocs.push({ file: agentsFile, content: withBlock(current, AGENTS_BLOCK) ?? current });
  }

  // The files sync generates whole; the state records a hash of what each held when sync rendered it.
  const generated = [
    { file: path.join(helmDir, 'values.yaml'), content: valuesYaml },
    ...templates,
    { file: path.join(currentDir, 'werf.yaml'), content: werfYaml },
    ...workflows,
  ];
  const outputs = [
    ...generated,
    ...agentsDocs,
    // The dashboard is Flarops' own code: a fix in it reaches the project with the next sync.
    ...dashboardFiles,
  ];
  // Line endings are not a difference: a checkout with autocrlf would otherwise be rewritten each time.
  const onDisk = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const differs = (o) => {
    if (!fs.existsSync(o.file)) return true;
    if (Buffer.isBuffer(o.content)) return !fs.readFileSync(o.file).equals(o.content);
    return onDisk(o.file) !== o.content;
  };
  // The hash of what sync rendered for a file last time: recorded, or - for a state written before
  // hashes were - the recorded state rendered again.
  const hashBefore = (o) => {
    if (recordedHashes) return recordedHashes[relative(o.file)] || null;
    return previousRender && previousRender.has(o.file) ? contentHash(previousRender.get(o.file)) : null;
  };
  const toWrite = outputs.filter(o => !locked.has(relative(o.file)) && differs(o));
  // A locked file is reported only when what sync renders for it changed - not merely because it was edited.
  const heldBack = outputs
    .filter(o => locked.has(relative(o.file)))
    .filter(o => (hashBefore(o) ? hashBefore(o) !== contentHash(o.content) : differs(o)))
    .map(o => relative(o.file));
  // A file whose content on disk is not what sync rendered last time was edited by hand.
  const handEdited = (o) => !Buffer.isBuffer(o.content) && !!hashBefore(o) && fs.existsSync(o.file)
    && contentHash(onDisk(o.file)) !== hashBefore(o);

  const nothing = changes.length === 0 && toWrite.length === 0 && orphans.length === 0 && dashboardStale.length === 0;
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  // Each warning or note is its own paragraph.
  const warn = (text) => { console.warn(paint(33, text)); console.warn(''); };

  if (nothing) {
    console.log('Deployment already matches flarops.yaml - nothing to do.');
    if (heldBack.length > 0) warn(`WARNING: syncLock kept these files as they are, so what changed in them did not reach them: ${heldBack.join(', ')}.`);
    return;
  }

  // Every path written or removed is checked before the first write: none may lead through a symlink.
  const deletions = [...dashboardStale, ...orphans.map(f => path.join(templatesDir, f))];
  try {
    for (const o of toWrite) assertNoSymlink(currentDir, o.file);
    for (const file of deletions) assertNoSymlink(currentDir, file, { parentsOnly: true });
    assertNoSymlink(currentDir, STATE_FILE);
  } catch (e) {
    if (!(e instanceof SymlinkError)) throw e;
    console.error(`\x1b[31mERROR: ${e.message}\x1b[0m`);
    console.error(check ? 'A sync would refuse to write anything.' : 'Nothing was written.');
    process.exit(1);
  }

  const { lines, secretsAdded, secretsRemoved } = formatChanges(changes);
  const allNotes = [...notes, ...dataNotes(previousState, config)];

  console.log(check ? 'flarops sync --check: these changes would be applied (nothing was written).' : 'Applying flarops.yaml:');
  if (lines.length > 0) for (const line of [...new Set(lines)]) console.log(`  ${line}`);
  else console.log(`  flarops.yaml is unchanged, but the files below differ from what it produces${toWrite.some(handEdited) ? ' (hand edits are marked)' : ''} - they are put back to match it`);
  console.log('');
  console.log(check ? 'Files that would be written:' : 'Files written:');
  for (const o of toWrite) {
    console.log(`  ${relative(o.file)}${handEdited(o) ? '   ' + paint(33, '(had hand edits - overwritten; restore them from git and list the file under syncLock to keep them)') : ''}`);
  }
  for (const file of dashboardStale) console.log(`  ${relative(file)} (removed: no longer part of the dashboard)`);
  for (const f of orphans) console.log(`  ${relative(path.join(templatesDir, f))} (removed: its service is no longer declared)`);
  console.log('');

  // What follows the change list; --check says all of it too, so a real run holds no surprise.
  const report = () => {
    for (const note of allNotes) warn(`NOTE: ${note}`);
    if (context.hasLocalhostWarnings) {
      const keys = [...new Set(context.localhostKeys || [])];
      warn(`WARNING: ${keys.length ? keys.join(', ') : 'some values'} still point${keys.length === 1 ? 's' : ''} at localhost, which inside a cluster reaches the pod itself. In flarops.yaml, use the service's name for traffic inside the cluster ("database", "api"), or the project's domain for anything a browser reaches.`);
    }
    if (heldBack.length > 0) {
      warn(`WARNING: syncLock kept these files as they are, so the changes above did not reach them: ${heldBack.join(', ')}. Carry what they need over by hand, or remove them from syncLock and run sync again.`);
    }

    // The GitHub Secrets this change needs: without one, its variable reaches the container empty.
    if (secretsAdded.length > 0 || secretsRemoved.length > 0) {
      const readers = secretReaders(declared);
      if (secretsAdded.length > 0) {
        console.log(paint(36, 'Before you push, create these GitHub repository secrets (Settings -> Secrets and variables -> Actions):'));
        for (const key of secretsAdded) {
          const who = readers.get(key);
          console.log(`  ${key}${who ? `   read by ${who.join(', ')}` : ''}      e.g. gh secret set ${key}`);
        }
        console.log('  Without one, the variable reaches the container empty.');
      }
      if (secretsRemoved.length > 0) console.log(`No longer used - you can delete these GitHub secrets: ${secretsRemoved.join(', ')}`);
      console.log('');
    }
  };

  if (check) {
    report();
    process.exitCode = 1;
    return;
  }

  try {
    for (const o of toWrite) safeWriteFile(currentDir, o.file, o.content);
    for (const file of deletions) safeUnlink(currentDir, file);
    config.fileHashes = Object.fromEntries(generated.map(o => [relative(o.file), contentHash(o.content)]));
    writeState(currentDir, config);
  } catch (e) {
    if (!(e instanceof SymlinkError)) throw e;
    console.error(`\x1b[31mERROR: ${e.message}\x1b[0m`);
    process.exit(1);
  }

  report();
  console.log(paint(32, 'Done.') + ` Next: review "git diff", then commit and push - a push to ${config.deployBranch || 'main'} deploys it.`);
};

module.exports.findOrphanTemplates = findOrphanTemplates;
module.exports.applyDeclarations = applyDeclarations;
module.exports.declaredServices = declaredServices;
module.exports.normalizeState = normalizeState;
module.exports.lineOf = lineOf;
