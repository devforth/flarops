// `flarops sync` - apply flarops.yaml to the generated deployment.
//
// flarops.yaml is the declarative description of what this project deploys.
// `flarops init` writes it once, from its own analysis of the repository, and
// from then on it is the file a person edits: change a parameter and sync
// carries that change into the chart, the values and the werf build; declare a
// service that was never there and sync creates it, from the same templates
// every discovered service is built from, with the defaults below standing in
// for everything the author did not spell out.
//
// Sync is a MERGE, not a regeneration. deploy/.flarops-state.json holds what
// init worked out by reading the repository - the DB URLs it rewrites into
// each container, a detected migration step, init-SQL, whether a Dockerfile
// needs the repo root as its build context. None of that belongs in a
// hand-edited file, and none of it can be re-derived from one, so declared
// values are laid over the discovered state rather than replacing it.
//
// Where the two disagree about something flarops.yaml does model, flarops.yaml
// wins. That is what "source of truth" means, and it is why sync reports every
// change it makes before writing anything.

const fs = require('fs');
const path = require('path');

const { parse, YamlError } = require('../../utils/yamlLite.js');
const { readState, writeState, STATE_FILE } = require('../../utils/state.js');
const { makeServiceEntry } = require('../../utils/analyzer.js');
const { normalizeRoutes } = require('../../utils/routes.js');
const { renderChartTemplates } = require('../../templates/chart.js');
const renderValues = require('../../templates/values.yaml.js');
const renderWerf = require('../../templates/werf.yaml.js');
const renderDeployWorkflow = require('../../templates/deploy.yml.js');
const renderPrCapsuleWorkflow = require('../../templates/pr-capsule.yml.js');

// The constant values a newly declared service starts from, before anything
// the author wrote in flarops.yaml is laid over them. A service created by
// hand and one discovered by init differ only in these.
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

// Services the chart gives their own templates to; every other key in
// flarops.yaml is an ordinary service.
const PRIMARY = new Set(['api', 'frontend', 'database']);

// Templates present in every chart, whatever the project contains.
const ALWAYS_PRESENT = new Set([
  '_helpers.tpl', '01-ingress.yaml', 'secret.yaml', 'registry-secret.yaml', 'dashboard.yaml',
]);

// --- reading flarops.yaml --------------------------------------------------

function declaredServices(text) {
  const doc = parse(text);
  const out = new Map();
  for (const [name, body] of Object.entries(doc)) {
    if (body !== null && typeof body !== 'object') {
      throw new YamlError(`"${name}" must be a service block, not a single value`);
    }
    if (Array.isArray(body)) {
      throw new YamlError(`"${name}" must be a service block, not a list`);
    }
    out.set(name, { ...SERVICE_DEFAULTS, ...(body || {}) });
  }
  return out;
}

// flarops.yaml states a secret as "container env name: Secret key", which is
// how they actually relate. The chart wants them split by whether the two
// names happen to coincide: the generic secretKeys loop handles the ones that
// do, and only the rest need an explicit mapping.
function splitSecretEnvs(secretEnvs) {
  const secretKeys = [];
  const extraSecretEnvMappings = [];
  for (const [envName, secretKey] of Object.entries(secretEnvs || {})) {
    if (envName === secretKey) secretKeys.push(envName);
    else extraSecretEnvMappings.push({ envName, secretKey: String(secretKey) });
  }
  return { secretKeys, extraSecretEnvMappings };
}

// "KEY=value" as docker and compose spell build args, back into a map.
//
// The field is `buildArgs`. It used to be `args`, which collided with
// Kubernetes' own `args` - the container's command line - so a reader could
// not tell from the name whether a value applied at build time or at run
// time. Files written before the rename still say `args`, and are still read.
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

// flarops.yaml states a volume as "name / path / size", which is how a person
// thinks about one. The chart's own shape calls the path `target`, because it
// came from docker-compose's "source:target" mounts.
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

// Accepts the old spelling so a file written before the rename keeps working.
function buildArgsOf(decl) {
  const declared = decl.buildArgs;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return decl.args;
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// --- applying a declaration to the discovered state ------------------------

// Records every field it actually changes, so sync can say what it did rather
// than rewriting files and leaving the operator to diff them.
function makeRecorder(changes) {
  // "absent" and "empty" are the same thing to every consumer of this state,
  // and reporting "volumes: none -> none" for each of ten services buries the
  // one line that says what actually changed.
  const normalize = (v) => {
    // A flag that is off is the same as a flag that was never written, so
    // "oneShot: none -> false" is not a change anyone needs to read.
    if (v === undefined || v === null || v === false) return null;
    if (Array.isArray(v)) return v.length === 0 ? null : v;
    if (typeof v === 'object' && Object.keys(v).length === 0) return null;
    return v;
  };
  const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  return function set(target, key, value, label) {
    if (same(target[key], value)) return;
    changes.push({ label, from: target[key], to: value });
    target[key] = value;
  };
}

function applyPrimary(config, name, decl, set) {
  const prefix = name === 'api' ? 'api' : 'frontend';
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);
  const cap = prefix[0].toUpperCase() + prefix.slice(1);

  set(config, `${prefix}Replicas`, decl.replicas, `${name}.replicas`);
  set(config, `${prefix}Ports`, asList(decl.ports).map(Number), `${name}.ports`);
  set(config, `${prefix}Env`, decl.env || {}, `${name}.env`);
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
    set(config, 'apiHealthRoute', decl.healthRoute, 'api.healthRoute');
    set(config, 'apiHealthPort', decl.healthPort, 'api.healthPort');
    set(config, 'apiRoutes', normalizeRoutes(asList(decl.exposedRoutes)), 'api.exposedRoutes');
  }
  set(config, `has${cap === 'Api' ? 'Backend' : 'Frontend'}`, true, `${name} present`);
}

function applyDatabase(config, decl, set) {
  set(config, 'dbReplicas', decl.replicas, 'database.replicas');
  if (decl.image) set(config.images, 'db', String(decl.image), 'database.image');
  if (decl.type) set(config, 'dbType', String(decl.type), 'database.type');
  if (decl.port) set(config, 'dbPort', Number(decl.port), 'database.port');
  if (decl.user) set(config, 'dbUser', String(decl.user), 'database.user');
  if (decl.name) set(config, 'dbName', String(decl.name), 'database.name');
  // Every env the database container takes the password under points at the
  // same Secret key; the chart only needs the key.
  const keys = Object.values(decl.secretEnvs || {});
  if (keys.length > 0) set(config, 'dbPasswordKey', String(keys[0]), 'database.secretEnvs');
  set(config, 'hasDb', true, 'database present');
}

// A service the state has never seen. It gets the full ServiceEntry shape so
// nothing downstream has to ask whether this one was declared or discovered.
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

function applyService(service, decl, set, label) {
  const { secretKeys, extraSecretEnvMappings } = splitSecretEnvs(decl.secretEnvs);
  set(service, 'replicas', decl.replicas, `${label}.replicas`);
  set(service, 'ports', asList(decl.ports).map(Number), `${label}.ports`);
  set(service, 'env', decl.env || {}, `${label}.env`);
  set(service, 'secretKeys',
    withoutDedicatedKeys(secretKeys, service.dbPasswordKey, service.springDatasourcePasswordSecretKey),
    `${label}.secretEnvs (same name)`);
  set(service, 'extraSecretEnvMappings', extraSecretEnvMappings, `${label}.secretEnvs (renamed)`);
  set(service, 'exposedRoutes', normalizeRoutes(asList(decl.exposedRoutes)), `${label}.exposedRoutes`);
  set(service, 'volumes', parseVolumes(decl.volumes), `${label}.volumes`);
  // A one-shot task has no Service object, so there is nothing for an Ingress
  // rule to point at. Saying so beats generating a route to nowhere.
  if (decl.oneShot && asList(decl.exposedRoutes).length > 0) {
    throw new YamlError(`"${label}" is oneShot, so it has no Service and cannot own exposedRoutes`);
  }
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
  if (decl.db) {
    const db = { ...(service.db || {}), ...decl.db };
    const dbKeys = Object.values(decl.db.secretEnvs || {});
    if (dbKeys.length > 0) db.passwordKey = String(dbKeys[0]);
    delete db.secretEnvs;
    set(service, 'db', db, `${label}.db`);
  }
}

// The recorded state predates flarops.yaml's vocabulary in two places, and
// without reconciling them a sync that changes nothing would still report - and
// write - changes, which makes every real change impossible to see.
//
//  * Replica counts were a constant in the values template, so the state has no
//    field for them. Absent means the default, which is what SERVICE_DEFAULTS
//    already says.
//  * The database password reaches a container through its own dedicated block,
//    not through secretKeys. flarops.yaml has no such distinction - it states
//    every secret the same way - so reading it back turns that key into an
//    ordinary secretKey. The rendered manifest is identical either way (the
//    template suppresses its block when the name is already emitted), but the
//    state would drift a little further from the chart on every run.
function normalizeState(config) {
  config.apiReplicas = config.apiReplicas || SERVICE_DEFAULTS.replicas;
  config.frontendReplicas = config.frontendReplicas || SERVICE_DEFAULTS.replicas;
  config.dbReplicas = config.dbReplicas || SERVICE_DEFAULTS.replicas;
  for (const service of [...(config.additionalServices || []), ...(config.supportServices || [])]) {
    service.replicas = service.replicas || SERVICE_DEFAULTS.replicas;
  }
}

// Drops the keys that have a dedicated block of their own, so they are not
// also emitted through the generic loop.
function withoutDedicatedKeys(secretKeys, ...dedicated) {
  const owned = new Set(dedicated.filter(Boolean));
  return secretKeys.filter(k => !owned.has(k));
}

// Which GitHub Secrets CI has to pass, derived from what flarops.yaml declares.
//
// The Secret the chart mounts is built from .Values.env, which CI fills from
// the SECRET_ENV_* lines in the workflows, which come from this list. A key
// declared in flarops.yaml but missing here is a secretKeyRef pointing at
// something that will never exist, and the pod sits in
// CreateContainerConfigError - the deployment looks generated and cannot
// start. Recomputing it is therefore part of applying the file, not an extra.
//
// DASHBOARD_PASSWORD_HASH is Flarops' own and is never declared, so it is kept
// unconditionally; dropping it leaves the dashboard unable to start, and with
// it every PR capsule that asks its capacity oracle.
const ALWAYS_PASSED = ['DASHBOARD_PASSWORD_HASH'];

function secretKeysFor(declared, config) {
  const keys = [];
  const add = (key) => { if (key && !keys.includes(key)) keys.push(key); };

  for (const decl of declared.values()) {
    for (const secretKey of Object.values(decl.secretEnvs || {})) add(String(secretKey));
    for (const secretKey of Object.values((decl.db || {}).secretEnvs || {})) add(String(secretKey));
  }
  add(config.dbPasswordKey);
  for (const key of ALWAYS_PASSED) add(key);

  // Keys still needed keep the order they already had, so re-running sync
  // without changing anything produces no diff in the workflows.
  const previous = config.envKeysToPass || [];
  const kept = previous.filter(k => keys.includes(k));
  return [...kept, ...keys.filter(k => !kept.includes(k))];
}

function applyDeclarations(state, declared) {
  const changes = [];
  const set = makeRecorder(changes);
  const config = state;
  normalizeState(config);

  const seenAdditional = new Set();
  const seenSupport = new Set();

  for (const [name, decl] of declared) {
    if (name === 'api' || name === 'frontend') { applyPrimary(config, name, decl, set); continue; }
    if (name === 'database') { applyDatabase(config, decl, set); continue; }

    // A service this repository BUILDS declares a dockerfile; one it only
    // pulls declares an image. That is the same distinction docker-compose
    // draws, and the one the template comment in flarops.yaml documents.
    const isBuilt = !!decl.dockerfile;
    const list = isBuilt ? (config.additionalServices ||= []) : (config.supportServices ||= []);
    (isBuilt ? seenAdditional : seenSupport).add(name);

    let service = list.find(s => s.name === name);
    if (!service) {
      service = isBuilt ? newService(name, decl) : { name, image: null, env: {}, secretKeys: [], extraSecretEnvMappings: [], ports: [], volumes: [] };
      list.push(service);
      changes.push({ label: `${name}: created from the shared template`, from: null, to: name });
    }
    applyService(service, decl, set, name);
  }

  // A service removed from flarops.yaml is removed from the deployment - that
  // is the only way the file can express a deletion, and leaving the workload
  // running would make the file a description of something else.
  for (const key of ['additionalServices', 'supportServices']) {
    const seen = key === 'additionalServices' ? seenAdditional : seenSupport;
    const before = config[key] || [];
    const after = before.filter(s => seen.has(s.name));
    for (const s of before) {
      if (!seen.has(s.name)) changes.push({ label: `${s.name}: no longer declared, removed`, from: s.name, to: null });
    }
    config[key] = after;
  }
  // Recomputed last, from everything the declarations turned out to need.
  const secretKeys = secretKeysFor(declared, config);
  const before = config.envKeysToPass || [];
  const added = secretKeys.filter(k => !before.includes(k));
  const removed = before.filter(k => !secretKeys.includes(k));
  if (added.length > 0 || removed.length > 0) {
    for (const key of added) changes.push({ label: `GitHub Secret ${key}: now required by the chart`, from: null, to: key });
    for (const key of removed) changes.push({ label: `GitHub Secret ${key}: no longer referenced`, from: key, to: null });
    config.envKeysToPass = secretKeys;
  }

  if (!declared.has('api')) set(config, 'hasBackend', false, 'api removed');
  if (!declared.has('frontend')) set(config, 'hasFrontend', false, 'frontend removed');
  if (!declared.has('database')) { set(config, 'hasDb', false, 'database removed'); set(config, 'dbType', null, 'database removed'); }

  return { config, changes };
}

// --- writing ---------------------------------------------------------------

// Every template the config implies, by filename.
function expectedTemplateNames(config, templatesDir) {
  return new Set(renderChartTemplates(config, templatesDir).map(t => path.basename(t.file)));
}

// Exported so `init` can warn about orphans without removing anything. Built
// from the SAME renderer that writes them, so a template that stops being
// generated is recognised as stale without this list being updated too.
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
  try {
    declared = declaredServices(fs.readFileSync(flaropsYamlFile, 'utf8'));
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

  const { config, changes } = applyDeclarations(state, declared);

  if (changes.length === 0) {
    console.log('Deployment already matches flarops.yaml - nothing to do.');
    return;
  }

  console.log('Applying flarops.yaml:');
  for (const c of changes) {
    if (c.from === null && c.to !== null && /created|removed/.test(c.label)) console.log(`  ${c.label}`);
    else console.log(`  ${c.label}: ${describe(c.from)} -> ${describe(c.to)}`);
  }
  console.log('');

  // Render first, write second: a template that throws must not leave the
  // chart half-updated.
  const context = { hasLocalhostWarnings: false };
  const valuesYaml = renderValues(config, context);
  const templates = renderChartTemplates(config, templatesDir);
  const werfYaml = renderWerf(config);
  // The workflows are re-rendered, not patched: they carry the SECRET_ENV_*
  // list, and every fact they need beyond it - registry, domain, region,
  // Cloudflare - is in the recorded state, so the same emitters init used can
  // produce them again. Patching just the secret lines would have left two
  // ways of writing a workflow to drift apart.
  const workflows = [
    { file: path.join(currentDir, '.github', 'workflows', 'deploy.yml'), content: renderDeployWorkflow(config) },
    { file: path.join(currentDir, '.github', 'workflows', 'pr-capsule.yml'), content: renderPrCapsuleWorkflow(config) },
  ];

  fs.writeFileSync(path.join(helmDir, 'values.yaml'), valuesYaml);
  for (const t of templates) fs.writeFileSync(t.file, t.content);
  fs.writeFileSync(path.join(currentDir, 'werf.yaml'), werfYaml);
  for (const w of workflows) {
    if (fs.existsSync(path.dirname(w.file))) fs.writeFileSync(w.file, w.content);
  }
  writeState(currentDir, config);

  const expected = expectedTemplateNames(config, templatesDir);
  for (const name of ALWAYS_PRESENT) expected.add(name);
  const orphans = fs.readdirSync(templatesDir)
    .filter(f => /\.(yaml|tpl)$/.test(f))
    .filter(f => !expected.has(f));
  for (const f of orphans) fs.unlinkSync(path.join(templatesDir, f));
  if (orphans.length > 0) {
    console.log(`Removed ${orphans.length} template(s) for services flarops.yaml no longer declares: ${orphans.join(', ')}`);
  }

  // A secret the chart now mounts has to be something CI actually puts in the
  // Secret, and CI only passes what the workflow names. Sync does not rewrite
  // the workflows - they carry registry and cloud settings it was never told -
  // so it says plainly what is missing rather than producing a chart that
  // cannot start.
  const needed = new Set();
  for (const decl of declared.values()) {
    for (const key of Object.values(decl.secretEnvs || {})) needed.add(String(key));
    for (const key of Object.values((decl.db || {}).secretEnvs || {})) needed.add(String(key));
  }
  const workflow = path.join(currentDir, '.github', 'workflows', 'deploy.yml');
  if (fs.existsSync(workflow)) {
    const text = fs.readFileSync(workflow, 'utf8');
    const missing = [...needed].filter(k => !new RegExp(`SECRET_ENV_${k}\\b`).test(text) && !new RegExp(`secrets\\.${k}\\b`).test(text));
    if (missing.length > 0) {
      console.warn(`\x1b[33mWARNING: these Secret keys are now referenced by the chart but not passed by .github/workflows/deploy.yml: ${missing.join(', ')}. Add a "SECRET_ENV_<KEY>: \${{ secrets.<KEY> }}" line for each under the deploy step's env:, and add the secret to the repository - without it those pods stay in CreateContainerConfigError.\x1b[0m`);
    }
  }

  if (context.hasLocalhostWarnings) {
    console.warn('\x1b[33mWARNING: some values still point at localhost, which inside a cluster reaches the pod itself. Change them to the service name in flarops.yaml.\x1b[0m');
  }

  console.log('\x1b[32mdeploy/helm, werf.yaml and the recorded state now match flarops.yaml.\x1b[0m');
  console.log('Review the diff, commit it, and redeploy.');
};

module.exports.findOrphanTemplates = findOrphanTemplates;
module.exports.applyDeclarations = applyDeclarations;
module.exports.declaredServices = declaredServices;
