// Validates flarops.yaml before sync applies it: these values are pasted unescaped into file
// names, workflows and werf.yaml.

const path = require('path');
const { YamlError } = require('./yamlLite.js');
const { ENGINES } = require('./dbDefaults.js');
const { REGISTRY_HOST, IMAGE_PATH } = require('./registry.js');

// Kubernetes object names (RFC 1123 label) - also safe as a file name.
const SERVICE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// A GitHub secret name: letters, digits and underscores, not starting with a
// digit. The same string is the key inside the Kubernetes Secret.
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A container environment variable name as Kubernetes accepts it.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// A URL path with nothing that could end the YAML scalar it is written into.
const URL_PATH = /^\/[^\s"'\\]*$/;
// Anything else that is pasted unquoted: no whitespace, quotes or backslashes.
const PLAIN_TOKEN = /^[^\s"'\\]+$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;

const DB_TYPES = new Set([...Object.keys(ENGINES), 'redis']);
const PRIMARY = new Set(['api', 'frontend', 'database']);

function fail(where, message) {
  throw new YamlError(`"${where}" ${message}`);
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
    if (!SECRET_KEY.test(String(secretKey))) {
      fail(`${where}.${envName}`, `names the secret ${JSON.stringify(String(secretKey))}, which is not a valid GitHub secret name (letters, digits and _, not starting with a digit)`);
    }
  }
}

function checkEnv(where, env) {
  if (env === null || env === undefined) return;
  if (typeof env !== 'object' || Array.isArray(env)) fail(where, 'must be a map of variable name to value');
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name)) fail(`${where}.${name}`, 'is not a valid environment variable name');
  }
}

function checkRoutes(where, routes) {
  asList(routes).forEach((route, i) => {
    const p = route && typeof route === 'object' ? route.path : route;
    if (!URL_PATH.test(String(p))) fail(`${where}[${i}]`, `must be a path starting with "/" and without spaces, quotes or backslashes, not ${JSON.stringify(p)}`);
  });
}

function checkRepoPath(where, value) {
  if (value === null || value === undefined) return;
  const text = String(value);
  if (!PLAIN_TOKEN.test(text)) fail(where, `must be a path without spaces, quotes or backslashes, not ${JSON.stringify(text)}`);
  const normalized = path.posix.normalize(text);
  if (path.posix.isAbsolute(text) || normalized === '..' || normalized.startsWith('../')) {
    fail(where, `must be a path inside the repository, not ${JSON.stringify(text)}`);
  }
}

function checkPlain(where, value) {
  if (value === null || value === undefined) return;
  if (!PLAIN_TOKEN.test(String(value))) fail(where, `must not contain spaces, quotes or backslashes, not ${JSON.stringify(String(value))}`);
}

function checkReplicas(where, value) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) fail(where, `must be a whole number of 0 or more, not ${JSON.stringify(value)}`);
}

function checkBuildArgs(where, args) {
  for (const entry of asList(args)) {
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq !== -1 && !ENV_NAME.test(text.slice(0, eq))) fail(where, `has a build arg named ${JSON.stringify(text.slice(0, eq))}, which is not a valid variable name`);
  }
}

function checkVolumes(where, volumes) {
  asList(volumes).forEach((v, i) => {
    if (!v || typeof v !== 'object') return; // shape errors are reported by the parser in sync
    // claimNameFor sanitizes the name; refuse only what would break the line.
    if (v.name !== undefined && !VOLUME_NAME.test(String(v.name))) fail(`${where}[${i}].name`, 'must be letters, digits, "-", "_" or "."');
    if (v.path !== undefined && !URL_PATH.test(String(v.path))) fail(`${where}[${i}].path`, 'must be an absolute path inside the container');
    if (v.size !== undefined && !QUANTITY.test(String(v.size))) fail(`${where}[${i}].size`, `must be a size such as 5Gi, not ${JSON.stringify(v.size)}`);
  });
}

// Each name gets a URL the chart builds; the same name from env or secretEnvs would be a second source.
function checkDatabaseUrls(name, decl) {
  if (decl.databaseUrls === undefined || decl.databaseUrls === null) return;
  const where = `${name}.databaseUrls`;
  if (name === 'frontend' || !(name === 'api' || decl.dockerfile)) {
    fail(where, 'is only for api and services built here - give this one its URL under secretEnvs');
  }
  const names = asList(decl.databaseUrls);
  for (const envName of names) {
    if (!ENV_NAME.test(String(envName))) fail(where, `must list environment variable names, not ${JSON.stringify(envName)}`);
    if (decl.env && Object.prototype.hasOwnProperty.call(decl.env, envName)) fail(where, `names ${envName}, which env also sets - keep one`);
    if (decl.secretEnvs && Object.prototype.hasOwnProperty.call(decl.secretEnvs, envName)) fail(where, `names ${envName}, which secretEnvs also sets - keep one`);
  }
}

function checkCommon(name, decl) {
  checkReplicas(`${name}.replicas`, decl.replicas);
  checkPorts(`${name}.ports`, decl.ports);
  if (decl.healthPort !== null && decl.healthPort !== undefined) checkPort(`${name}.healthPort`, decl.healthPort);
  if (decl.healthRoute !== null && decl.healthRoute !== undefined && !URL_PATH.test(String(decl.healthRoute))) {
    fail(`${name}.healthRoute`, 'must be a path starting with "/"');
  }
  checkEnv(`${name}.env`, decl.env);
  checkSecretEnvs(`${name}.secretEnvs`, decl.secretEnvs);
  checkRoutes(`${name}.exposedRoutes`, decl.exposedRoutes);
  checkRepoPath(`${name}.context`, decl.context);
  checkRepoPath(`${name}.dockerfile`, decl.dockerfile);
  checkPlain(`${name}.image`, decl.image);
  checkBuildArgs(`${name}.buildArgs`, decl.buildArgs);
  checkBuildArgs(`${name}.args`, decl.args);
  checkVolumes(`${name}.volumes`, decl.volumes);
  checkDatabaseUrls(name, decl);
}

function checkDatabase(where, db) {
  if (!db || typeof db !== 'object') return;
  if (db.type !== null && db.type !== undefined && !DB_TYPES.has(String(db.type).toLowerCase())) {
    fail(`${where}.type`, `must be one of ${[...DB_TYPES].join(', ')}, not ${JSON.stringify(db.type)}`);
  }
  if (db.port !== null && db.port !== undefined) checkPort(`${where}.port`, db.port);
  checkPlain(`${where}.image`, db.image);
  checkPlain(`${where}.user`, db.user);
  checkPlain(`${where}.name`, db.name);
  checkReplicas(`${where}.replicas`, db.replicas);
  checkSecretEnvs(`${where}.secretEnvs`, db.secretEnvs);
}

function validateDeclarations(declared) {
  for (const [name, decl] of declared) {
    if (!PRIMARY.has(name)) {
      if (!SERVICE_NAME.test(name) || name.length > 63) {
        fail(name, 'is not a valid service name - use lowercase letters, digits and "-", at most 63 characters, starting and ending with a letter or digit');
      }
    }
    if (name === 'database') {
      checkDatabase(name, decl);
      continue;
    }
    checkCommon(name, decl);
    checkDatabase(`${name}.db`, decl.db);
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

module.exports = { validateDeclarations, validateRepositorySettings };
