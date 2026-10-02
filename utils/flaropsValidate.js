// What flarops.yaml may contain, checked before `flarops sync` applies any of it.
//
// Every value in the file ends up pasted into something else: a service name
// becomes a FILE NAME under deploy/helm/templates and a Kubernetes object name,
// a secret key becomes a line in both GitHub workflows, a context becomes a
// path in werf.yaml. None of those writers escape - they were written for what
// init produces, which is already well-formed. A hand-edited file is not, and
// nothing stood between the two: a service named "../../../.github/workflows/x"
// wrote a file into .github/workflows, and a secret key holding "\n" added
// lines of its own to deploy.yml.
//
// So the shapes are enforced here, once, with a message naming the field -
// rather than escaped in each of the places a value can reach.

const path = require('path');
const { YamlError } = require('./yamlLite.js');
const { ENGINES } = require('./dbDefaults.js');

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

// A path inside the repository: relative, and not climbing out of it.
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
    // Turned into a claim name by claimNameFor (templates/generic/volumes.js),
    // so compose spellings like "postgres_data" are fine - only what could
    // break the line it is written on is refused.
    if (v.name !== undefined && !VOLUME_NAME.test(String(v.name))) fail(`${where}[${i}].name`, 'must be letters, digits, "-", "_" or "."');
    if (v.path !== undefined && !URL_PATH.test(String(v.path))) fail(`${where}[${i}].path`, 'must be an absolute path inside the container');
    if (v.size !== undefined && !QUANTITY.test(String(v.size))) fail(`${where}[${i}].size`, `must be a size such as 5Gi, not ${JSON.stringify(v.size)}`);
  });
}

// Fields every service block can carry.
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

// Throws YamlError on the first value that cannot be applied safely.
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

module.exports = { validateDeclarations };
