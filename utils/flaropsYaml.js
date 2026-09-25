// Generates `flarops.yaml` - the declarative source of truth for every service
// Flarops manages.  Written once by `flarops init`, it describes each service's
// build/image, replicas, env, secrets and (when detected) resource limits.
//
// The file is intended to be human-editable and committed alongside the rest of
// the project.  A trailing comment block doubles as a template that documents
// every supported field.

// ---------------------------------------------------------------------------
// YAML helpers – we deliberately avoid a YAML library (Flarops has zero
// runtime deps) and produce the output by hand.  The shapes are simple enough
// that this is safe.
// ---------------------------------------------------------------------------

const { passwordKeyFor } = require('./dbDefaults');
const { normalizeRoutes } = require('./routes');

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  // Quote anything that might confuse a YAML parser - including a reader that
  // is not this one. YAML 1.1, which PyYAML and many other tools still
  // implement, reads yes/no/on/off as BOOLEANS; YAML 1.2 reads them as text.
  // An unquoted "yes" in a container's command therefore means the string
  // "yes" to one reader and the string "true" to another, and the file is
  // meant to be readable by both. redis-server --appendonly yes is exactly
  // this case and is not rare.
  const YAML_11_BOOLEANS = /^(y|n|yes|no|true|false|on|off)$/i;
  if (s === '' || s === 'null' || s === '~' || YAML_11_BOOLEANS.test(s) ||
      /^[\d.]+$/.test(s) || /[:#\[\]{}&*!|>'"%@`]/.test(s) ||
      s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(l => pad + l).join('\n');
}

// ---------------------------------------------------------------------------
// Render a single service block
// ---------------------------------------------------------------------------

function renderEnvBlock(envObj, indent) {
  const entries = Object.entries(envObj || {});
  if (entries.length === 0) return null;
  const pad = ' '.repeat(indent);
  return entries.map(([k, v]) => `${pad}${k}: ${yamlScalar(v)}`).join('\n');
}

function renderSecretEnvBlock(secretKeys, extraMappings, indent) {
  // secretKeys: [KEY, KEY2, …] – wired from a GH secret of the same name
  // extraMappings: [{ envName, secretKey }, …] – env name differs from the secret name
  //
  // This renders a YAML MAPPING, where a repeated key is not a duplicate entry
  // but a silently discarded one - the parser keeps the last. The sources feed
  // in from independent detection paths that don't know about each other, so
  // the same container-side name can arrive more than once; the first wins,
  // and the order below puts the most specific statement first. The container
  // env list in the chart has the same hazard with a louder failure, and is
  // reconciled in init.js - this is the format-level guard, not a substitute
  // for that one.
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

// ---------------------------------------------------------------------------
// Build the service descriptor from init's internal state
// ---------------------------------------------------------------------------

function serviceBlock(name, opts) {
  const lines = [];

  // image vs dockerfile+context (mutually exclusive)
  if (opts.image) {
    lines.push(`  image: ${yamlScalar(opts.image)}`);
  }
  if (opts.dockerfile) {
    lines.push(`  dockerfile: ${yamlScalar(opts.dockerfile)}`);
  }
  if (opts.context !== undefined && opts.context !== null) {
    lines.push(`  context: ${yamlScalar(opts.context)}`);
  }

  // A one-shot task runs to completion instead of staying up, so a replica
  // count would be meaningless for it.
  if (opts.oneShot) {
    lines.push('  oneShot: true');
  } else {
    lines.push(`  replicas: ${opts.replicas || 1}`);
  }

  // ports
  const portsStr = renderPorts(opts.ports, 4);
  if (portsStr) {
    lines.push('  ports:');
    lines.push(portsStr);
  }

  // build args
  const argsStr = renderBuildArgs(opts.buildArgs, 4);
  if (argsStr) {
    lines.push('  buildArgs:');
    lines.push(argsStr);
  }

  // command
  const cmdStr = renderCommand(opts.command, 4);
  if (cmdStr) {
    lines.push('  command:');
    lines.push(cmdStr);
  }

  // env
  const envStr = renderEnvBlock(opts.env, 4);
  if (envStr) {
    lines.push('  env:');
    lines.push(envStr);
  }

  // secretEnvs. The chart writes the DB password - and Spring's fixed
  // SPRING_DATASOURCE_PASSWORD - from their own dedicated blocks rather than
  // through the generic secretKeys loop, so a file built from secretKeys alone
  // claimed those containers needed no database credential at all. They are
  // mappings like any other; the dedup above collapses them when a more
  // specific statement already covers the same name.
  const allMappings = [...(opts.extraSecretEnvMappings || [])];
  if (opts.dbPasswordKey) {
    allMappings.push({ envName: opts.dbPasswordKey, secretKey: opts.dbPasswordKey });
  }
  if (opts.springDatasourcePasswordSecretKey) {
    allMappings.push({ envName: 'SPRING_DATASOURCE_PASSWORD', secretKey: opts.springDatasourcePasswordSecretKey });
  }
  const secretStr = renderSecretEnvBlock(opts.secretKeys, allMappings, 4);
  if (secretStr) {
    lines.push('  secretEnvs:');
    lines.push(secretStr);
  }

  // volumes. Declared beside the path they mount at, because a size means
  // nothing without knowing what is stored there.
  if (Array.isArray(opts.volumes) && opts.volumes.length > 0) {
    lines.push('  volumes:');
    for (const v of opts.volumes) {
      lines.push(`    - name: ${yamlScalar(v.name)}`);
      lines.push(`      path: ${yamlScalar(v.target)}`);
      if (v.size) lines.push(`      size: ${yamlScalar(v.size)}`);
    }
  }

  // healthRoute / healthPort
  if (opts.healthRoute) {
    lines.push(`  healthRoute: ${yamlScalar(opts.healthRoute)}`);
  }
  if (opts.healthPort) {
    lines.push(`  healthPort: ${opts.healthPort}`);
  }

  // exposedRoutes
  const routes = normalizeRoutes(opts.exposedRoutes);
  if (routes.length > 0) {
    lines.push('  exposedRoutes:');
    for (const r of routes) {
      // The short form for the ordinary case; the long one only where the
      // route actually carries a transformation, so the common file stays
      // a list of paths.
      if (!r.stripPrefix) lines.push(`    - ${yamlScalar(r.path)}`);
      else lines.push(`    - path: ${yamlScalar(r.path)}`, '      stripPrefix: true');
    }
  }

  // db (for additional services with own database)
  if (opts.db && !opts.db.shared) {
    lines.push('  db:');
    lines.push(`    type: ${yamlScalar(opts.db.type)}`);
    lines.push(`    image: ${yamlScalar(opts.db.image)}`);
    lines.push(`    port: ${opts.db.port}`);
    lines.push(`    user: ${yamlScalar(opts.db.user)}`);
    lines.push(`    name: ${yamlScalar(opts.db.name)}`);
    // This database is a workload of its own - the chart gives it a Deployment
    // and mounts its password exactly like the shared one's.
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

// The database container takes its password under a name the IMAGE dictates,
// which is not the name of the Secret key holding it - postgres wants
// POSTGRES_PASSWORD, mongo wants MONGO_INITDB_ROOT_PASSWORD, and the key is
// whatever this project's password was generated or discovered under. Both
// halves belong in flarops.yaml: without them the file claims to describe
// every service while the one service whose credential the whole deployment
// turns on appears to need no secret at all.
//
// The name itself comes from utils/dbDefaults, the one table the chart and
// the PR-capsule clone commands also answer this question from. Writing a
// fresh engine switch here would have made a fifth copy of a mapping that has
// already drifted once (see that file's own header).
function databaseSecretEnvNames(dbType, dbUser) {
  const rootKey = passwordKeyFor(dbType);
  const names = [rootKey];
  // The only part the shared table does not answer. mysql and mariadb take a
  // SECOND credential for a non-root user, and the chart sets it only when the
  // user is not root - root already has its password from <PREFIX>_ROOT_PASSWORD,
  // and setting both for the same account makes the entrypoint fail. Derived
  // from the root key rather than a second engine switch, and confined to these
  // two engines because mongodb's key also contains _ROOT_ while having no such
  // pair.
  const engine = String(dbType || '').toLowerCase();
  if ((engine === 'mysql' || engine === 'mariadb') && dbUser && dbUser !== 'root') {
    names.push(rootKey.replace('_ROOT_PASSWORD', '_PASSWORD'));
  }
  return names;
}

// ---------------------------------------------------------------------------
// The trailing template/comment
// ---------------------------------------------------------------------------

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
# Paths in \`dockerfile\` and \`context\` are RELATIVE TO THE PROJECT ROOT
# (not relative to the deploy directory, and not the way werf spells them).
#
# --- Required fields --------------------------------------------------------
#
# my-service:
#   # OPTION A: pre-built image (not built locally)
#   image: "registry.example.com/org/image:tag"
#
#   # OPTION B: built from a Dockerfile in this repository
#   dockerfile: "path/to/Dockerfile"        # relative to project root
#   context: "path/to"                      # Docker build context, relative to project root
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
#     type: "postgres"                      # postgres | mysql | mariadb | mongodb
#     image: "postgres:18-alpine"
#     port: 5432
#     user: "postgres"
#     name: "mydb"
#
# ============================================================================`.trimStart();

// ---------------------------------------------------------------------------
// Main entry point – called from init.js after the config object is assembled
// ---------------------------------------------------------------------------

function generateFlaropsYaml(config, {
  apiEnv, frontendEnv, apiSecretKeys, frontendSecretKeys,
  apiExtraSecretEnvMappings, frontendExtraSecretEnvMappings,
  apiBuildArgs, frontendBuildArgs, apiCommand, frontendCommand,
}) {
  const blocks = [];

  // --- api ---
  if (config.hasBackend) {
    blocks.push(serviceBlock('api', {
      dockerfile: config.apiDockerfile,
      context: config.backendPath || '.',
      replicas: 1,
      ports: config.apiPorts,
      buildArgs: apiBuildArgs,
      command: apiCommand,
      env: apiEnv,
      secretKeys: apiSecretKeys,
      extraSecretEnvMappings: apiExtraSecretEnvMappings,
      healthRoute: config.apiHealthRoute,
      healthPort: config.apiHealthPort,
      exposedRoutes: config.apiRoutes,
      dbPasswordKey: config.hasDbPassword ? config.dbPasswordKey : null,
    }));
  }

  // --- frontend ---
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

  // --- database ---
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

  // --- additional services ---
  for (const s of (config.additionalServices || [])) {
    blocks.push(serviceBlock(s.name, {
      dockerfile: s.dockerfile,
      context: s.relativePath || '.',
      replicas: 1,
      ports: s.ports,
      buildArgs: s.buildArgs,
      command: s.command,
      env: s.env,
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

  // --- support services ---
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

  return blocks.join('\n\n') + '\n\n' + TEMPLATE_COMMENT + '\n';
}

module.exports = { generateFlaropsYaml };
