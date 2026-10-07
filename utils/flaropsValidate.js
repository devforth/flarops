// Validates flarops.yaml before sync applies it: these values are pasted unescaped into file
// names, workflows and werf.yaml.

const path = require('path');
const { YamlError } = require('./yamlLite.js');
const { ENGINES } = require('./dbDefaults.js');
const { REGISTRY_HOST, IMAGE_PATH } = require('./registry.js');
const { claimNameFor } = require('../templates/generic/volumes.js');

// A Kubernetes Service name (RFC 1035 label) - also safe as a file name.
const SERVICE_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const MAX_SERVICE_NAME = 63;
// "<name>-db" names a StatefulSet; its pods carry "<name>-db-<revision hash>", which must fit in 63.
const MAX_SERVICE_NAME_WITH_DB = 49;
// Names a YAML reader takes for something other than a string, and names Flarops' own objects use.
const RESERVED_SERVICE_NAMES = new Set([
  'null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n',
  'secret', 'dashboard', 'registry-secret',
]);
// A GitHub secret name: letters, digits and underscores, not starting with a
// digit. The same string is the key inside the Kubernetes Secret.
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The deploy pipeline's own credentials: routing one into a container hands it the infrastructure.
// GitHub secret names are case-insensitive, and GITHUB_* belongs to GitHub itself.
const RESERVED_SECRET = /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SSH_PRIVATE_KEY|REGISTRY_PASSWORD|DASHBOARD_PASSWORD_HASH|CLOUDFLARE_[A-Z0-9_]*|GITHUB_[A-Z0-9_]*)$/i;
// A container environment variable name as Kubernetes accepts it.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// A URL path with nothing that could end the YAML scalar it is written into, or open a Helm action.
const URL_PATH = /^\/[^\s"'\\{}]*$/;
// Anything else that is pasted unquoted: no whitespace, quotes or backslashes.
const PLAIN_TOKEN = /^[^\s"'\\]+$/;
// A database user or name: also reaches workflow env, where ${{ }} would be evaluated.
const DB_IDENTIFIER = /^[^\s"'\\${}]+$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;

const DB_TYPES = new Set(Object.keys(ENGINES));
const PRIMARY = new Set(['api', 'frontend', 'database']);

// The keys each kind of block takes; anything else is a typo or a field that does not exist.
const BUILT_KEYS = ['dockerfile', 'context', 'replicas', 'oneShot', 'ports', 'buildArgs', 'args', 'command',
  'env', 'secretEnvs', 'volumes', 'healthRoute', 'healthPort', 'exposedRoutes', 'databaseUrls', 'db'];
const KEYS = {
  api: ['dockerfile', 'context', 'replicas', 'ports', 'buildArgs', 'args', 'command', 'env', 'secretEnvs',
    'healthRoute', 'healthPort', 'exposedRoutes', 'databaseUrls'],
  frontend: ['dockerfile', 'context', 'replicas', 'ports', 'buildArgs', 'args', 'command', 'env', 'secretEnvs'],
  database: ['image', 'dockerfile', 'context', 'replicas', 'port', 'user', 'name', 'type', 'command', 'secretEnvs'],
  db: ['type', 'image', 'port', 'user', 'name', 'replicas', 'command', 'secretEnvs'],
  built: BUILT_KEYS,
  support: ['image', 'replicas', 'oneShot', 'ports', 'command', 'env', 'secretEnvs', 'volumes'],
};

function fail(where, message) {
  throw new YamlError(`"${where}" ${message}`);
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function has(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function checkKeys(where, block, allowed) {
  for (const key of Object.keys(block || {})) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, `is not a field here - use ${allowed.join(', ')}`);
  }
}

function checkPort(where, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(where, `must be a port number from 1 to 65535, not ${JSON.stringify(value)}`);
}

function checkPorts(where, value) {
  asList(value).forEach((p, i) => checkPort(`${where}[${i}]`, p));
}

function checkSecretEnvs(where, secretEnvs) {
  if (secretEnvs === null || secretEnvs === undefined) return;
  if (typeof secretEnvs !== 'object' || Array.isArray(secretEnvs)) fail(where, 'must map a container variable name to a secret key');
  for (const [envName, secretKey] of Object.entries(secretEnvs)) {
    if (!ENV_NAME.test(envName)) fail(`${where}.${envName}`, 'is not a valid environment variable name');
    if (typeof secretKey !== 'string' || secretKey === '') {
      fail(`${where}.${envName}`, `needs the name of the GitHub secret it reads, such as "${envName}: ${envName}"`);
    }
    if (!SECRET_KEY.test(String(secretKey))) {
      fail(`${where}.${envName}`, `names the secret ${JSON.stringify(String(secretKey))}, which is not a valid GitHub secret name (letters, digits and _, not starting with a digit)`);
    }
    if (RESERVED_SECRET.test(String(secretKey))) {
      fail(`${where}.${envName}`, `names ${secretKey}, one of the deploy pipeline's own credentials - it cannot be handed to a container`);
    }
  }
}

function checkEnv(where, env) {
  if (env === null || env === undefined) return;
  if (typeof env !== 'object' || Array.isArray(env)) fail(where, 'must be a map of variable name to value');
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) fail(`${where}.${name}`, 'is not a valid environment variable name');
    if (value !== null && typeof value === 'object') fail(`${where}.${name}`, 'must be a single value, not a list or a map');
  }
}

function checkRoutes(where, routes) {
  asList(routes).forEach((route, i) => {
    const p = route && typeof route === 'object' ? route.path : route;
    if (!URL_PATH.test(String(p))) fail(`${where}[${i}]`, `must be a path starting with "/" and without spaces, quotes, backslashes or braces, not ${JSON.stringify(p)}`);
  });
}

function checkRepoPath(where, value, base = '.') {
  if (value === null || value === undefined) return;
  const text = String(value);
  if (!PLAIN_TOKEN.test(text) || /[{}]/.test(text)) fail(where, `must be a path without spaces, quotes, backslashes or braces, not ${JSON.stringify(text)}`);
  const normalized = path.posix.normalize(path.posix.join(String(base), text));
  if (path.posix.isAbsolute(text) || normalized === '..' || normalized.startsWith('../')) {
    fail(where, `must be a path inside the repository, not ${JSON.stringify(text)}`);
  }
}

function checkPlain(where, value) {
  if (value === null || value === undefined) return;
  if (!PLAIN_TOKEN.test(String(value))) fail(where, `must not contain spaces, quotes or backslashes, not ${JSON.stringify(String(value))}`);
}

function checkReplicas(where, value, max = Infinity) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) fail(where, `must be a whole number of 0 or more, not ${JSON.stringify(value)}`);
  if (value > max) fail(where, `must be 0 or 1 - more replicas would be separate databases behind one address, each with its own data`);
}

function checkBuildArgs(where, args) {
  if (args === null || args === undefined) return;
  if (!Array.isArray(args)) fail(where, 'must be a list of KEY=value entries');
  for (const entry of args) {
    if (entry === null || typeof entry === 'object') fail(where, `must be a list of KEY=value entries, not ${JSON.stringify(entry)}`);
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq === -1) fail(where, `has ${JSON.stringify(text)}, which is not written as KEY=value`);
    if (!ENV_NAME.test(text.slice(0, eq))) fail(where, `has a build arg named ${JSON.stringify(text.slice(0, eq))}, which is not a valid variable name`);
  }
}

// What the container runs: a list of arguments, or one string.
function checkCommand(where, command) {
  if (command === null || command === undefined) return;
  const list = Array.isArray(command) ? command : [command];
  for (const arg of list) {
    if (arg === null || typeof arg === 'object') fail(where, `must be a list of arguments (text), not ${JSON.stringify(arg)}`);
  }
}

function checkVolumes(where, volumes) {
  asList(volumes).forEach((v, i) => {
    if (!v || typeof v !== 'object') return; // shape errors are reported by the parser in sync
    checkKeys(`${where}[${i}]`, v, ['name', 'path', 'size']);
    // claimNameFor sanitizes the name; refuse only what would break the line.
    if (v.name !== undefined && !VOLUME_NAME.test(String(v.name))) fail(`${where}[${i}].name`, 'must be letters, digits, "-", "_" or "."');
    if (v.path !== undefined && !URL_PATH.test(String(v.path))) fail(`${where}[${i}].path`, 'must be an absolute path inside the container, without spaces, quotes or braces');
    if (v.size !== undefined && !QUANTITY.test(String(v.size))) fail(`${where}[${i}].size`, `must be a size such as 5Gi, not ${JSON.stringify(v.size)}`);
  });
}

// Each name gets one source; the same name twice is a duplicate env entry, which Kubernetes rejects.
function checkEnvSources(name, decl) {
  const urls = asList(decl.databaseUrls).map(String);
  for (const envName of Object.keys(decl.env || {})) {
    if (has(decl.secretEnvs, envName)) fail(`${name}.env.${envName}`, 'is also under secretEnvs - keep one');
  }
  for (const envName of urls) {
    if (has(decl.env, envName)) fail(`${name}.databaseUrls`, `names ${envName}, which env also sets - keep one`);
    if (has(decl.secretEnvs, envName)) fail(`${name}.databaseUrls`, `names ${envName}, which secretEnvs also sets - keep one`);
  }
}

function checkDatabaseUrls(name, decl) {
  if (decl.databaseUrls === undefined || decl.databaseUrls === null) return;
  for (const envName of asList(decl.databaseUrls)) {
    if (!ENV_NAME.test(String(envName))) fail(`${name}.databaseUrls`, `must list environment variable names, not ${JSON.stringify(envName)}`);
  }
}

function checkCommon(name, decl) {
  checkReplicas(`${name}.replicas`, decl.replicas);
  checkPorts(`${name}.ports`, decl.ports);
  if (decl.healthPort !== null && decl.healthPort !== undefined) checkPort(`${name}.healthPort`, decl.healthPort);
  if (decl.healthRoute !== null && decl.healthRoute !== undefined && !URL_PATH.test(String(decl.healthRoute))) {
    fail(`${name}.healthRoute`, 'must be a path starting with "/", without spaces, quotes or braces');
  }
  checkEnv(`${name}.env`, decl.env);
  checkSecretEnvs(`${name}.secretEnvs`, decl.secretEnvs);
  checkRoutes(`${name}.exposedRoutes`, decl.exposedRoutes);
  checkRepoPath(`${name}.context`, decl.context);
  checkRepoPath(`${name}.dockerfile`, decl.dockerfile, decl.context || '.');
  checkPlain(`${name}.image`, decl.image);
  checkBuildArgs(`${name}.buildArgs`, decl.buildArgs);
  checkBuildArgs(`${name}.args`, decl.args);
  checkCommand(`${name}.command`, decl.command);
  checkVolumes(`${name}.volumes`, decl.volumes);
  checkDatabaseUrls(name, decl);
  checkEnvSources(name, decl);
}

function checkDatabase(where, db, { requireTypeAndPassword }) {
  if (db === null || db === undefined) return;
  if (typeof db !== 'object' || Array.isArray(db)) fail(where, 'must be a block with type, image, port, user, name and secretEnvs');
  checkKeys(where, db, where === 'database' ? KEYS.database : KEYS.db);
  if (db.type !== null && db.type !== undefined && !DB_TYPES.has(String(db.type).toLowerCase())) {
    fail(`${where}.type`, `must be one of ${[...DB_TYPES].join(', ')}, not ${JSON.stringify(db.type)}`);
  }
  if (requireTypeAndPassword) {
    if (!db.type) fail(`${where}.type`, `is required - one of ${[...DB_TYPES].join(', ')}`);
    if (!db.secretEnvs || Object.keys(db.secretEnvs).length === 0) {
      fail(`${where}.secretEnvs`, 'is required - the database password, such as "POSTGRES_PASSWORD: ORDERS_DB_PASSWORD"');
    }
  }
  if (db.port !== null && db.port !== undefined) checkPort(`${where}.port`, db.port);
  checkPlain(`${where}.image`, db.image);
  for (const field of ['user', 'name']) {
    if (db[field] !== null && db[field] !== undefined && !DB_IDENTIFIER.test(String(db[field]))) {
      fail(`${where}.${field}`, `must not contain spaces, quotes, backslashes, "$" or braces, not ${JSON.stringify(String(db[field]))}`);
    }
  }
  checkReplicas(`${where}.replicas`, db.replicas, 1);
  checkCommand(`${where}.command`, db.command);
  checkSecretEnvs(`${where}.secretEnvs`, db.secretEnvs);
  if (where === 'database') {
    checkRepoPath(`${where}.context`, db.context);
    checkRepoPath(`${where}.dockerfile`, db.dockerfile, db.context || '.');
  }
}

function checkServiceName(name, decl) {
  if (PRIMARY.has(name)) return;
  if (!SERVICE_NAME.test(name)) {
    fail(name, 'is not a valid service name - use lowercase letters, digits and "-", starting with a letter and ending with a letter or digit');
  }
  if (RESERVED_SERVICE_NAMES.has(name) || name.startsWith('flarops-')) {
    fail(name, 'is a name Flarops or YAML already uses - pick another service name');
  }
  const max = decl && decl.db ? MAX_SERVICE_NAME_WITH_DB : MAX_SERVICE_NAME;
  if (name.length > max) {
    fail(name, `is longer than ${max} characters${decl && decl.db ? ' (a service with its own db: gets a "-db" StatefulSet, whose pods need room for a suffix)' : ''}`);
  }
}

// `declared` holds each block as written, before sync lays its defaults over it.
function validateDeclarations(declared) {
  for (const [name, decl] of declared) {
    checkServiceName(name, decl);
    if (name === 'database') {
      checkDatabase(name, decl, { requireTypeAndPassword: false });
      continue;
    }
    const kind = PRIMARY.has(name) ? name : (decl.dockerfile ? 'built' : 'support');
    checkKeys(name, decl, KEYS[kind]);
    if (kind === 'support' && !decl.image) {
      fail(name, 'needs either image (a pre-built image) or dockerfile and context (built from this repository)');
    }
    if (kind === 'api' && has(decl, 'ports') && asList(decl.ports).length === 0) {
      fail(`${name}.ports`, 'needs at least one port - the Ingress routes to the first');
    }
    checkCommon(name, decl);
    checkDatabase(`${name}.db`, decl.db, { requireTypeAndPassword: true });
    if (decl.oneShot && asList(decl.exposedRoutes).length > 0) {
      fail(name, 'is oneShot, so it has no Service and cannot own exposedRoutes');
    }
  }
  // Claim names are sanitized ("data_a" and "data-a" both become <service>-data-a): two volumes must
  // not end up sharing one claim.
  const claims = new Map();
  for (const [name, decl] of declared) {
    for (const v of asList(decl && decl.volumes)) {
      if (!v || typeof v !== 'object' || v.name === undefined) continue;
      const claim = claimNameFor(name, String(v.name));
      if (claims.has(claim)) fail(`${name}.volumes`, `"${v.name}" would share the claim ${claim} with ${claims.get(claim)} - rename one`);
      claims.set(claim, `${name}.volumes "${v.name}"`);
    }
  }

  // "<name>-db" is the StatefulSet of a service's own database; a service by that name would replace it.
  for (const [name, decl] of declared) {
    if (decl && decl.db && declared.has(`${name}-db`)) {
      fail(`${name}-db`, `is the name of ${name}'s own database - pick another service name`);
    }
  }
}

// syncLock: repository-relative paths of files sync must leave alone, each true or false. Which
// paths sync actually writes is checked by sync, which knows the files it renders.
function validateSyncLock(block) {
  if (block === null || block === undefined) return;
  if (typeof block !== 'object' || Array.isArray(block)) {
    fail('syncLock', 'must be a map of file paths to true or false, such as "deploy/helm/templates/api.yaml: true"');
  }
  for (const [file, locked] of Object.entries(block)) {
    if (typeof locked !== 'boolean') fail(`syncLock.${file}`, `must be true or false, not ${JSON.stringify(locked)}`);
    const parts = file.split('/');
    if (file.startsWith('/') || file.includes('\\') || parts.some(p => p === '' || p === '.' || p === '..')) {
      fail(`syncLock.${file}`, 'must be a path relative to the project root, such as deploy/helm/templates/api.yaml');
    }
  }
}

const REPOSITORY_FIELDS = ['registry', 'project', 'repository'];

// The repositorySettings block: registry host, optional project, repository name.
function validateRepositorySettings(block) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    fail('repositorySettings', 'must be a block with registry, project and repository');
  }
  for (const key of Object.keys(block)) {
    if (!REPOSITORY_FIELDS.includes(key)) fail(`repositorySettings.${key}`, 'is not a setting - use registry, project or repository');
  }
  if (block.registry !== undefined && !REGISTRY_HOST.test(String(block.registry))) {
    fail('repositorySettings.registry', `must be a registry host such as docker.io or harbor.example.com (no path), not ${JSON.stringify(block.registry)}`);
  }
  if (block.project !== undefined && block.project !== null && !IMAGE_PATH.test(String(block.project))) {
    fail('repositorySettings.project', `must be lowercase letters, digits, ".", "_", "-" (and "/" between parts), or null - not ${JSON.stringify(block.project)}`);
  }
  if (block.repository !== undefined && (block.repository === null || !IMAGE_PATH.test(String(block.repository)))) {
    fail('repositorySettings.repository', `must be lowercase letters, digits, ".", "_", "-" (and "/" between parts), not ${JSON.stringify(block.repository)}`);
  }
}

module.exports = {
  validateDeclarations, validateRepositorySettings, validateSyncLock,
  SERVICE_NAME, RESERVED_SERVICE_NAMES, RESERVED_SECRET, MAX_SERVICE_NAME, MAX_SERVICE_NAME_WITH_DB,
};
