// Generates flarops.yaml, the file the user edits; `flarops sync` applies it.

const { passwordKeyFor } = require('./dbDefaults');
const { registrySettings } = require('./registry');
const { normalizeRoutes } = require('./routes');

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  // Quote YAML 1.1 booleans (yes/no/on/off) and anything else a parser could misread.
  const YAML_11_BOOLEANS = /^(y|n|yes|no|true|false|on|off)$/i;
  // Anything that reads as a number (-0700, +1, .5), and any control character or edge whitespace.
  if (s === '' || s === 'null' || s === '~' || YAML_11_BOOLEANS.test(s) ||
      /^[-+]?[\d.]/.test(s) || /^[-?:](\s|$)/.test(s) || /[:#\[\]{}&*!|>'"%@`]/.test(s) ||
      /[\u0000-\u001f\u007f]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
  }
  return s;
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(l => pad + l).join('\n');
}

function renderEnvBlock(envObj, indent) {
  const entries = Object.entries(envObj || {});
  if (entries.length === 0) return null;
  const pad = ' '.repeat(indent);
  return entries.map(([k, v]) => `${pad}${k}: ${yamlScalar(v)}`).join('\n');
}

function renderSecretEnvBlock(secretKeys, extraMappings, indent) {
  // A mapping: a repeated key would silently lose a value, so mappings come first and same-name keys
  // are skipped when already present.
  const ordered = [
    ...(extraMappings || []).map(m => [m.envName, m.secretKey]),
    ...(secretKeys || []).map(k => [k, k]),
  ];
  const seen = new Map();
  for (const [envName, secretKey] of ordered) {
    if (!seen.has(envName)) seen.set(envName, secretKey);
  }
  if (seen.size === 0) return null;

  const pad = ' '.repeat(indent);
  return [...seen].map(([envName, secretKey]) => `${pad}${envName}: ${secretKey}`).join('\n');
}

function renderBuildArgs(args, indent) {
  if (!args || Object.keys(args).length === 0) return null;
  const pad = ' '.repeat(indent);
  return Object.entries(args).map(([k, v]) => `${pad}- ${yamlScalar(k + '=' + v)}`).join('\n');
}

function renderCommand(command, indent) {
  if (!Array.isArray(command) || command.length === 0) return null;
  const pad = ' '.repeat(indent);
  return command.map(a => `${pad}- ${yamlScalar(a)}`).join('\n');
}

function renderPorts(ports, indent) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const pad = ' '.repeat(indent);
  return ports.map(p => `${pad}- ${p}`).join('\n');
}

// volumes: as flarops.yaml spells them, at the given indent.
function volumesLines(volumes, indent) {
  if (!Array.isArray(volumes) || volumes.length === 0) return [];
  const pad = ' '.repeat(indent);
  const out = [`${pad}volumes:`];
  for (const v of volumes) {
    out.push(`${pad}  - name: ${yamlScalar(v.name)}`);
    out.push(`${pad}    path: ${yamlScalar(v.target)}`);
    if (v.size) out.push(`${pad}    size: ${yamlScalar(v.size)}`);
  }
  return out;
}

function serviceBlock(name, opts) {
  const lines = [];

  if (opts.image) {
    lines.push(`  image: ${yamlScalar(opts.image)}`);
  }
  if (opts.dockerfile) {
    lines.push(`  dockerfile: ${yamlScalar(opts.dockerfile)}`);
  }
  if (opts.context !== undefined && opts.context !== null) {
    lines.push(`  context: ${yamlScalar(opts.context)}`);
  }

  if (opts.oneShot) {
    lines.push('  oneShot: true');
  } else {
    lines.push(`  replicas: ${opts.replicas || 1}`);
  }

  const portsStr = opts.oneShot ? null : renderPorts(opts.ports, 4);
  if (opts.oneShot) {
    // A task has no Service: no ports.
  } else if (portsStr) {
    lines.push('  ports:');
    lines.push(portsStr);
  } else if (Array.isArray(opts.ports)) {
    // Written explicitly, or sync would apply its default of port 80.
    lines.push('  ports: []');
  }

  const argsStr = renderBuildArgs(opts.buildArgs, 4);
  if (argsStr) {
    lines.push('  buildArgs:');
    lines.push(argsStr);
  }

  const cmdStr = renderCommand(opts.command, 4);
  if (cmdStr) {
    lines.push('  command:');
    lines.push(cmdStr);
  }

  const envStr = renderEnvBlock(opts.env, 4);
  if (envStr) {
    lines.push('  env:');
    lines.push(envStr);
  }

  // The DB password (and Spring's SPRING_DATASOURCE_PASSWORD) come from dedicated blocks in the chart;
  // list them here too so the file describes every secret the container receives.
  const allMappings = [...(opts.extraSecretEnvMappings || [])];
  if (opts.dbPasswordKey) {
    allMappings.push({ envName: opts.dbPasswordKey, secretKey: opts.dbPasswordKey });
  }
  if (opts.springDatasourcePasswordSecretKey) {
    allMappings.push({ envName: 'SPRING_DATASOURCE_PASSWORD', secretKey: opts.springDatasourcePasswordSecretKey });
  }
  if (Array.isArray(opts.databaseUrls) && opts.databaseUrls.length > 0) {
    lines.push('  databaseUrls:');
    for (const envName of opts.databaseUrls) lines.push(`    - ${yamlScalar(envName)}`);
  }

  const secretStr = renderSecretEnvBlock(opts.secretKeys, allMappings, 4);
  if (secretStr) {
    lines.push('  secretEnvs:');
    lines.push(secretStr);
  }

  lines.push(...volumesLines(opts.volumes, 2));

  if (opts.healthRoute) {
    lines.push(`  healthRoute: ${yamlScalar(opts.healthRoute)}`);
  }
  if (opts.healthPort) {
    lines.push(`  healthPort: ${opts.healthPort}`);
  }

  const routes = normalizeRoutes(opts.exposedRoutes);
  if (routes.length > 0) {
    lines.push('  exposedRoutes:');
    for (const r of routes) {
      if (!r.stripPrefix) lines.push(`    - ${yamlScalar(r.path)}`);
      else lines.push(`    - path: ${yamlScalar(r.path)}`, '      stripPrefix: true');
    }
  }

  if (opts.db && !opts.db.shared) {
    lines.push('  db:');
    lines.push(`    type: ${yamlScalar(opts.db.type)}`);
    lines.push(`    image: ${yamlScalar(opts.db.image)}`);
    lines.push(`    port: ${opts.db.port}`);
    lines.push(`    user: ${yamlScalar(opts.db.user)}`);
    lines.push(`    name: ${yamlScalar(opts.db.name)}`);
    const dbCmdStr = renderCommand(opts.db.command, 6);
    if (dbCmdStr) lines.push('    command:', dbCmdStr);
    lines.push(...volumesLines(opts.db.volumes, 4));
    if (opts.db.passwordKey) {
      const names = databaseSecretEnvNames(opts.db.type, opts.db.user);
      if (names.length > 0) {
        lines.push('    secretEnvs:');
        for (const envName of names) {
          lines.push(`      ${envName}: ${yamlScalar(opts.db.passwordKey)}`);
        }
      }
    }
  }

  return `${name}:\n` + lines.join('\n');
}

// The env names each database image reads its password under, all pointing at one Secret key.
function databaseSecretEnvNames(dbType, dbUser) {
  const rootKey = passwordKeyFor(dbType);
  const names = [rootKey];
  // mysql/mariadb take a second credential for a non-root user.
  const engine = String(dbType || '').toLowerCase();
  if ((engine === 'mysql' || engine === 'mariadb') && dbUser && dbUser !== 'root') {
    names.push(rootKey.replace('_ROOT_PASSWORD', '_PASSWORD'));
  }
  return names;
}

// The top of the file: what it is, and where its reference is.
const HEADER = [
  '# What Flarops deploys. Edit this file, then run "npx flarops sync" from this directory and',
  '# commit what it changed; a push to the deploy branch deploys it. Every field is described in the',
  '# reference at the end of this file.',
].join('\n');

const TEMPLATE_COMMENT = `
# ============================================================================
# Reference
#
# "npx flarops sync" applies this file: a changed field updates what is
# deployed, a block added here becomes a new service (anything left out gets
# a default), and a block removed is removed from the deployment.
# "npx flarops sync --check" shows what it would change without writing.
#
# --- Service names -----------------------------------------------------------
#
# Each top-level key other than repositorySettings and syncLock is a service.
# A name is lowercase letters, digits and "-", starts with a letter, ends with
# a letter or digit, and is at most 63 characters (49 with a db: block). Not
# allowed: secret, dashboard, registry-secret, flarops-..., and words YAML
# reads as something else (null, true, false, yes, no, on, off, y, n).
#
# --- repositorySettings ------------------------------------------------------
#
# registry:   the registry host the images are pushed to (no path).
# project:    the namespace inside it, or null.
# repository: the repository name.
# user:       optional - the login CI pushes as (REGISTRY_USER in the
#             workflows); init's answer when left out. The password is the
#             REGISTRY_PASSWORD GitHub secret: when registry, project or user
#             changes, update that secret so it belongs to this login.
#
# --- The special blocks ------------------------------------------------------
#
# api:        the backend; the Ingress routes its exposedRoutes to it.
# frontend:   the web frontend; it answers every path no other service owns.
# database:   the shared database. Fields: type, image (or dockerfile and
#             context), port, user, name, replicas (0 or 1), command,
#             volumes, secretEnvs - as in db: below.
#
# --- Any service ---------------------------------------------------------------
#
# my-service:
#   # Exactly one of:
#   image: "registry.example.com/org/image:tag"   # a pre-built image, or
#   context: "path/to"                      # built from this repository: the
#   dockerfile: "Dockerfile"                #  build context, relative to the
#                                           #  project root, and the Dockerfile,
#                                           #  relative to context
#
#   replicas: 1                             # optional, 1 by default
#   ports:                                  # container ports
#     - 8080
#   command:                                # what the container runs: replaces
#     - "node"                              #  the image's CMD and keeps its
#     - "server.js"                         #  ENTRYPOINT, like compose's command:
#   env:                                    # plain values - never a secret
#     APP_ENV: "production"
#   secretEnvs:                             # <variable the code reads>: <GitHub
#     STRIPE_KEY: STRIPE_KEY                #  Secret it comes from> - the NAME of
#     DB_PASSWORD: SHARED_DB_PASSWORD       #  a secret, never its value
#   volumes:                                # persistent storage, one claim each
#     - name: "data"                        #  (<service>-<name>). size is
#       path: "/var/lib/service"            #  optional: 5Gi, 10Gi on a database.
#       size: "20Gi"                        #  Removing a volume keeps its data; a
#                                           #  new size reaches new claims only.
#                                           #  PR environments start empty.
#   oneShot: true                           # a task, not a service: runs to the
#                                           #  end on every deploy (so it must be
#                                           #  safe to repeat). Takes no replicas,
#                                           #  ports, health check or routes.
#
# --- Only for services built here (dockerfile:), and api ----------------------
#
#   buildArgs:                              # docker build --build-arg
#     - "API_URL=https://example.com"
#   healthRoute: "/health"                  # readiness and liveness probe path
#   healthPort: 8080                        #  and its port
#   exposedRoutes:                          # Ingress path prefixes routed here
#     - "/webhooks"                         #  passed through unchanged
#     - path: "/api"                        #  the service sees "/api" removed
#       stripPrefix: true
#   databaseUrls:                           # variables that get the database's
#     - DATABASE_URL                        #  connection URL, built from its user,
#                                           #  password and name: this service's
#                                           #  db: if it has one, otherwise the
#                                           #  top-level database. No secret needed.
#   db:                                     # a database of this service's own
#     type: "postgres"                      # required: postgres | mysql | mariadb | mongodb
#     image: "postgres:18-alpine"           # optional, like everything below
#     port: 5432                            #  but secretEnvs: the engine's
#     user: "postgres"                      #  defaults fill in the rest
#     name: "mydb"
#     replicas: 1                           # 0 or 1
#     command:                              # server settings
#       - "postgres"
#       - "-c"
#       - "wal_level=logical"
#     volumes:                              # "data" is the database's own disk
#       - name: data
#         path: "/var/lib/postgresql"
#         size: "20Gi"
#     secretEnvs:                           # required: the password
#       POSTGRES_PASSWORD: MY_SERVICE_DB_PASSWORD
#
# A database already created keeps the name, user and password it was created
# with; sync says so when one of them changes.
# ============================================================================`.trimStart();

// Where the images are pushed. Not a service: the key has an uppercase letter, which no service
// name can have.
function repositorySettingsBlock(config) {
  const { host, project, repository } = registrySettings(config);
  const line = (text, note) => `${text.padEnd(36)}# ${note}`;
  return [
    '# Where the built images are pushed.',
    'repositorySettings:',
    line(`  registry: ${yamlScalar(host)}`, 'registry host; docker.io is Docker Hub'),
    line(`  project: ${project ? yamlScalar(project) : 'null'}`, 'namespace inside the registry (a Harbor project, an organisation);'),
    line('', 'null for none - on Docker Hub, your own user'),
    line(`  repository: ${yamlScalar(repository)}`, 'repository the images are pushed to'),
  ].join('\n');
}

// Files "flarops sync" leaves alone; init writes the key empty so the option is visible.
const SYNC_LOCK_BLOCK = [
  '# Chart templates (deploy/helm/templates/) and workflows (.github/workflows/) you changed by',
  '# hand, for something this file cannot express. Sync leaves a listed file as it is and says',
  '# which changes did not reach it. deploy/helm/values.yaml and werf.yaml cannot be listed.',
  '#',
  '# syncLock:',
  '#   deploy/helm/templates/api.yaml: true',
  '#   .github/workflows/deploy.yml: true',
  'syncLock: {}',
].join('\n');

function generateFlaropsYaml(config, {
  apiEnv, frontendEnv, apiSecretKeys, frontendSecretKeys,
  apiExtraSecretEnvMappings, frontendExtraSecretEnvMappings,
  apiBuildArgs, frontendBuildArgs, apiCommand, frontendCommand,
}) {
  const blocks = [];

  if (config.hasBackend) {
    blocks.push(serviceBlock('api', {
      dockerfile: config.apiDockerfile,
      context: config.backendPath || '.',
      replicas: 1,
      ports: config.apiPorts,
      buildArgs: apiBuildArgs,
      command: apiCommand,
      env: apiEnv,
      databaseUrls: config.hasDb ? (config.dbUrlVars || []).map(v => v.key) : [],
      secretKeys: apiSecretKeys,
      extraSecretEnvMappings: apiExtraSecretEnvMappings,
      healthRoute: config.apiHealthRoute,
      healthPort: config.apiHealthPort,
      exposedRoutes: config.apiRoutes,
      volumes: config.apiVolumes,
      dbPasswordKey: config.hasDbPassword ? config.dbPasswordKey : null,
    }));
  }

  if (config.hasFrontend) {
    blocks.push(serviceBlock('frontend', {
      dockerfile: config.frontendDockerfile,
      context: config.frontendPath || '.',
      replicas: 1,
      ports: config.frontendPorts,
      buildArgs: frontendBuildArgs,
      command: frontendCommand,
      env: frontendEnv,
      secretKeys: frontendSecretKeys,
      extraSecretEnvMappings: frontendExtraSecretEnvMappings,
      volumes: config.frontendVolumes,
    }));
  }

  if (config.hasDb) {
    // The order of a db: block: type, image, port, user, name, replicas, command, volumes, secretEnvs.
    const dbLines = [];
    if (config.dbType) dbLines.push(`  type: ${yamlScalar(config.dbType)}`);
    if (config.dbHasLocalDockerfile) {
      dbLines.push(`  dockerfile: ${yamlScalar(config.dbLocalDockerfile || 'Dockerfile')}`);
      if (config.dbContext) {
        dbLines.push(`  context: ${yamlScalar(config.dbContext)}`);
      }
    } else {
      dbLines.push(`  image: ${yamlScalar(config.images.db)}`);
    }
    if (config.dbPort) dbLines.push(`  port: ${config.dbPort}`);
    if (config.dbUser) dbLines.push(`  user: ${yamlScalar(config.dbUser)}`);
    if (config.dbName) dbLines.push(`  name: ${yamlScalar(config.dbName)}`);
    dbLines.push(`  replicas: 1`);
    const dbCmdStr = renderCommand(config.dbCommand, 4);
    if (dbCmdStr) dbLines.push('  command:', dbCmdStr);
    dbLines.push(...volumesLines(config.dbVolumes, 2));
    const dbSecretNames = config.dbPasswordKey
      ? databaseSecretEnvNames(config.dbType, config.dbUser)
      : [];
    if (dbSecretNames.length > 0) {
      dbLines.push('  secretEnvs:');
      for (const envName of dbSecretNames) {
        dbLines.push(`    ${envName}: ${yamlScalar(config.dbPasswordKey)}`);
      }
    }
    blocks.push('database:\n' + dbLines.join('\n'));
  }

  for (const s of (config.additionalServices || [])) {
    blocks.push(serviceBlock(s.name, {
      dockerfile: s.dockerfile,
      context: s.relativePath || '.',
      replicas: 1,
      ports: s.ports,
      buildArgs: s.buildArgs,
      command: s.command,
      env: s.env,
      databaseUrls: s.db ? (s.dbUrlVars || []).map(v => v.key) : [],
      secretKeys: s.secretKeys,
      extraSecretEnvMappings: s.extraSecretEnvMappings,
      healthRoute: s.healthRoute,
      healthPort: s.healthPort,
      exposedRoutes: s.exposedRoutes,
      volumes: s.volumes,
      oneShot: s.oneShot,
      db: s.db,
      dbPasswordKey: s.dbPasswordKey,
      springDatasourcePasswordSecretKey: s.springDatasourcePasswordSecretKey,
    }));
  }

  for (const s of (config.supportServices || [])) {
    blocks.push(serviceBlock(s.name, {
      image: s.image,
      replicas: 1,
      ports: s.ports,
      command: s.command,
      env: s.env,
      secretKeys: s.secretKeys,
      extraSecretEnvMappings: s.extraSecretEnvMappings,
      volumes: s.volumes,
      oneShot: s.oneShot,
    }));
  }

  return HEADER + '\n\n' + repositorySettingsBlock(config) + '\n\n' + SYNC_LOCK_BLOCK + '\n\n' + blocks.join('\n\n') + '\n\n' + TEMPLATE_COMMENT + '\n';
}

module.exports = { generateFlaropsYaml };
