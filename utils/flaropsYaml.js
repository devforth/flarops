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

  const portsStr = renderPorts(opts.ports, 4);
  if (portsStr) {
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

  if (Array.isArray(opts.volumes) && opts.volumes.length > 0) {
    lines.push('  volumes:');
    for (const v of opts.volumes) {
      lines.push(`    - name: ${yamlScalar(v.name)}`);
      lines.push(`      path: ${yamlScalar(v.target)}`);
      if (v.size) lines.push(`      size: ${yamlScalar(v.size)}`);
    }
  }

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

const TEMPLATE_COMMENT = `
# ============================================================================
# This file is the source of truth for what gets deployed. Edit it, then run
#
#     flarops sync
#
# which applies every change here to deploy/helm, werf.yaml and the recorded
# state: a changed parameter updates the existing object, a service added below
# is created from the same templates a discovered one is built from (with
# defaults for anything left out), and a service removed from here is removed
# from the deployment. \`flarops init\` does not run twice - sync is how a
# generated project changes from then on.
#
# Template for adding new services to this file.
#
# Each top-level key is a service name (must be unique, RFC-1123 compatible).
# A service MUST have either \`image\` OR \`dockerfile\` + \`context\`, and \`replicas\`.
#
# \`context\` is RELATIVE TO THE PROJECT ROOT (not to the deploy directory);
# \`dockerfile\` is relative to \`context\`, as in docker-compose and werf.
#
# --- Required fields --------------------------------------------------------
#
# my-service:
#   # OPTION A: pre-built image (not built locally)
#   image: "registry.example.com/org/image:tag"
#
#   # OPTION B: built from a Dockerfile in this repository
#   context: "path/to"                      # Docker build context, relative to project root
#   dockerfile: "Dockerfile"                # relative to context (path/to/Dockerfile here)
#
#   replicas: 1                             # number of pod replicas
#
# --- A task instead of a service --------------------------------------------
#
#   oneShot: true                           # runs to completion and stops,
#                                           #  instead of staying up. Rendered
#                                           #  as a Job that re-runs on every
#                                           #  deploy, so the command must be
#                                           #  safe to repeat. Replaces
#                                           #  replicas; no ports, no probes,
#                                           #  no exposedRoutes - a task has no
#                                           #  Service to route to.
#
# --- Optional fields --------------------------------------------------------
#
#   ports:                                  # container ports to expose
#     - 8080
#
#   buildArgs:                              # passed to "docker build --build-arg"
#     - "BUILD_MODE=production"              # (spelled "args" in older files,
#     - "API_URL=https://example.com"        #  still accepted)
#
#   command:                                # what the container RUNS - this
#     - "node"                              #  becomes the pod's args:, which
#     - "server.js"                         #  replaces the image's CMD and
#                                           #  keeps its ENTRYPOINT, exactly as
#                                           #  docker-compose's command: does.
#
#   env:                                    # plain-text environment variables
#     DATABASE_HOST: "database"
#     APP_ENV: "production"
#
#   databaseUrls:                           # env vars that get the database's
#     - DATABASE_URL                        #  connection URL, built by the chart
#                                           #  from its user, password and name -
#                                           #  this service's own db: if it has
#                                           #  one, otherwise the top-level
#                                           #  database. No GitHub Secret needed.
#
#   secretEnvs:                             # env vars sourced from GitHub Secrets
#     SECRET_KEY: SECRET_KEY                # env name: GitHub Secret name
#     DB_PASSWORD: SHARED_DB_PASSWORD       # env name can differ from secret name
#
#   volumes:                                # persistent storage, one claim each
#     - name: "data"                        # any name; the claim is <service>-<name>
#       path: "/var/lib/service"            # where it is mounted in the container
#       size: "20Gi"                        # optional, 5Gi by default
#
#   healthRoute: "/health"                  # readiness/liveness probe path
#   healthPort: 8080                        # port for the health probe
#
#   exposedRoutes:                          # Ingress path prefixes routed here
#     - "/webhooks"                          #  passed through unchanged
#     - path: "/api"                         #  the service sees requests with
#       stripPrefix: true                    #  "/api" removed - use this when a
#                                            #  reverse proxy did it before
#
#   db:                                     # per-service database (generates its own StatefulSet)
#     type: "postgres"                      # required: postgres | mysql | mariadb | mongodb
#     secretEnvs:                           # required: the password, as for a service
#       POSTGRES_PASSWORD: MY_SERVICE_DB_PASSWORD
#     image: "postgres:18-alpine"           # optional, like the rest: the engine's
#     port: 5432                            #  defaults fill in what is left out;
#     user: "postgres"                      #  port moves the Service address only -
#     name: "mydb"                          #  the server keeps its own port
#     replicas: 1                           # 0 or 1
#     command:                              # server settings, as in compose;
#       - "postgres"                        #  the same field works on the
#       - "-c"                              #  top-level database: block
#       - "wal_level=logical"
#
# ============================================================================`.trimStart();

// Where the images are pushed. Not a service: the key has an uppercase letter, which no service
// name can have.
function repositorySettingsBlock(config) {
  const { host, project, repository } = registrySettings(config);
  const line = (text, note) => `${text.padEnd(36)}# ${note}`;
  return [
    '# repository settings',
    'repositorySettings:',
    line(`  registry: ${yamlScalar(host)}`, 'registry host; docker.io is Docker Hub'),
    line(`  project: ${project ? yamlScalar(project) : 'null'}`, 'namespace inside the registry (a Harbor project, an organisation);'),
    line('', 'null for none - on Docker Hub, your own user'),
    line(`  repository: ${yamlScalar(repository)}`, 'repository the images are pushed to'),
  ].join('\n');
}

// Files "flarops sync" leaves alone; init writes the key empty so the option is visible.
const SYNC_LOCK_BLOCK = [
  '# sync lock',
  '# Files "flarops sync" must not overwrite - for a change Flarops cannot',
  '# express, made by hand in a chart template or a workflow. List each with',
  '# true; sync then leaves it as it is and says which changes did not reach it:',
  '#',
  '# syncLock:',
  '#   deploy/helm/templates/api.yaml: true',
  '#   .github/workflows/deploy.yml: true',
  '#',
  '# deploy/helm/values.yaml and werf.yaml cannot be locked.',
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
    }));
  }

  if (config.hasDb) {
    const dbLines = [];
    if (config.dbHasLocalDockerfile) {
      dbLines.push(`  dockerfile: ${yamlScalar(config.dbLocalDockerfile || 'Dockerfile')}`);
      if (config.dbContext) {
        dbLines.push(`  context: ${yamlScalar(config.dbContext)}`);
      }
    } else {
      dbLines.push(`  image: ${yamlScalar(config.images.db)}`);
    }
    dbLines.push(`  replicas: 1`);
    if (config.dbPort) dbLines.push(`  port: ${config.dbPort}`);
    if (config.dbUser) dbLines.push(`  user: ${yamlScalar(config.dbUser)}`);
    if (config.dbName) dbLines.push(`  name: ${yamlScalar(config.dbName)}`);
    if (config.dbType) dbLines.push(`  type: ${yamlScalar(config.dbType)}`);
    const dbCmdStr = renderCommand(config.dbCommand, 4);
    if (dbCmdStr) dbLines.push('  command:', dbCmdStr);
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

  return repositorySettingsBlock(config) + '\n\n' + SYNC_LOCK_BLOCK + '\n\n' + blocks.join('\n\n') + '\n\n' + TEMPLATE_COMMENT + '\n';
}

module.exports = { generateFlaropsYaml };
