const fs = require('fs').promises;
const path = require('path');
const { walkDir, logDebug } = require('./fsHelper');
const { SERVICE_SCAN_IGNORED_DIRS } = require('./constants');

// Conventional names for a "run this before the app starts" script - schema
// migrations plus seed/first-user data, the exact thing cookiecutter-style
// templates (e.g. this FastAPI template's own backend/scripts/prestart.sh,
// which runs `alembic upgrade head` then creates the first superuser) ship
// as a plain shell script the operator is expected to run once before/while
// deploying. Flarops has no way to run arbitrary migration tooling for every
// framework, but *this* convention is common and cheap to detect.
const PRESTART_SCRIPT_CANDIDATES = ['scripts/prestart.sh', 'scripts/migrate.sh', 'prestart.sh', 'migrate.sh'];

// How many worker processes the backend's own Dockerfile spawns (uvicorn/
// gunicorn `--workers N`/`-w N`, or a `WEB_CONCURRENCY`/`WORKERS` env var).
// Each worker is a full copy of the process (its own interpreter, loaded
// modules, DB connection pool, etc.), so a fixed one-size-fits-all memory
// limit sized for a single process gets the container OOMKilled the moment
// the image actually runs several of them - a very easy thing to miss since
// the worker count lives in the Dockerfile/CMD, not in any of the env/port
// signals already scanned elsewhere.
async function detectApiWorkerCount(backendPath, dockerfileName) {
  if (!backendPath || !dockerfileName) return 1;
  try {
    const content = await fs.readFile(path.join(backendPath, dockerfileName), 'utf8');
    const patterns = [
      /--workers[\s,="']+(\d+)/i,
      /-w[\s,="']+(\d+)/i,
      /WEB_CONCURRENCY[=:\s"']+(\d+)/i,
      /\bWORKERS[=:\s"']+(\d+)/i,
    ];
    for (const p of patterns) {
      const m = content.match(p);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0) return n;
      }
    }
  } catch (e) { logDebug(e); }
  return 1;
}

// Returns { checkFile, command } - checkFile is a path (relative to the
// backend) whose presence in the built image gates actually running command,
// so a wrong guess about the container's layout degrades to "skip" instead of
// crashing the init container forever.
async function detectApiMigrationStep(backendPath) {
  if (!backendPath) return null;
  for (const candidate of PRESTART_SCRIPT_CANDIDATES) {
    try {
      await fs.access(path.join(backendPath, candidate));
      return { checkFile: candidate, command: `bash ${candidate}` };
    } catch (e) { /* try next candidate */ }
  }
  // Django's own convention: no wrapper script ships at all, but the
  // presence of manage.py at the backend root means `manage.py migrate` is
  // the schema-migration step this project uses.
  try {
    await fs.access(path.join(backendPath, 'manage.py'));
    return { checkFile: 'manage.py', command: 'python manage.py migrate' };
  } catch (e) { /* not a Django project */ }
  return null;
}

// Splits a compose file into its top-level service blocks, keyed by service
// name. Matching a service name at ANY indentation (the previous approach)
// also matches it where it appears as a key inside another service's
// depends_on map -
//   frontend:
//     depends_on:
//       api-gateway:
//         condition: service_healthy
// - and the block then ran on to the end of the NEXT real service, so that
// service's published ports were attributed to this one. Anchoring to the
// indentation of the first service under "services:" is what makes a header a
// header.
function splitComposeServiceBlocks(content) {
  const blocks = {};
  const servicesMatch = content.match(/^services:\s*$/m);
  if (!servicesMatch) return blocks;
  const afterServices = content.slice(servicesMatch.index + servicesMatch[0].length);

  const firstServiceMatch = afterServices.match(/^([ \t]+)([a-zA-Z0-9_.-]+):\s*$/m);
  if (!firstServiceMatch) return blocks;
  const indent = firstServiceMatch[1];

  const blockRegex = new RegExp('^' + indent + '([a-zA-Z0-9_.-]+):\\s*$([\\s\\S]*?)(?=^' + indent + '[a-zA-Z0-9_.-]+:\\s*$|^\\S|(?![\\s\\S]))', 'gm');
  let m;
  while ((m = blockRegex.exec(afterServices)) !== null) blocks[m[1]] = m[2];
  return blocks;
}

async function findPortsInCompose(baseDir, possibleServiceNames) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  const ports = new Set();
  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      const serviceBlocks = splitComposeServiceBlocks(content);
      for (const serviceName of possibleServiceNames) {
        const serviceBlock = serviceBlocks[serviceName];
        if (serviceBlock !== undefined) {
          // Find port mappings like "80:80", "127.0.0.1:3000:3000"
          const portRegex = /^\s*-\s*["']?(?:\d+\.\d+\.\d+\.\d+:)?\d+:(\d+)["']?/gm;
          let portMatch;
          while ((portMatch = portRegex.exec(serviceBlock)) !== null) {
            ports.add(parseInt(portMatch[1], 10));
          }

          // Services fronted by a reverse proxy (e.g. Traefik) often have no
          // "ports:" mapping at all - the real listen port only shows up as a
          // "traefik.http.services.<name>.loadbalancer.server.port=PORT" label.
          const traefikPortRegex = /loadbalancer\.server\.port=(\d+)/gi;
          let traefikMatch;
          while ((traefikMatch = traefikPortRegex.exec(serviceBlock)) !== null) {
            ports.add(parseInt(traefikMatch[1], 10));
          }

          // Fall back to the port embedded in a healthcheck probe URL
          // (e.g. `curl -f http://localhost:8000/health`), another common
          // place the real listen port is the only place it's written down.
          const healthcheckPortRegex = /healthcheck:[\s\S]*?:\/\/[^:\/\s"']+:(\d+)/i;
          const healthcheckMatch = healthcheckPortRegex.exec(serviceBlock);
          if (healthcheckMatch) {
            ports.add(parseInt(healthcheckMatch[1], 10));
          }
        }
      }
    } catch (e) { logDebug(e); }
  }
  return Array.from(ports);
}



// Resolves the build context directory for a compose service matched by
// exact name (e.g. "api"), not by substring against directory names. A repo
// can easily contain several directories that all happen to contain "api" as
// a substring (e.g. "javaapi" and "nodeapi") with no reliable way to rank them
// by name alone - but the project's own docker-compose.yml already states,
// unambiguously, which one IS "the api" service. That's a stronger signal
// than any directory-name heuristic and should be checked first.
async function findServiceContextFromCompose(baseDir, serviceNames) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }

    for (const serviceName of serviceNames) {
      const serviceRegex = new RegExp('^([ \\t]+)' + serviceName + ':\\s*$([\\s\\S]*?)(?=^\\1[a-zA-Z0-9_-]+:\\s*$|^\\S|(?![\\s\\S]))', 'gm');
      const match = serviceRegex.exec(content);
      if (!match) continue;

      const block = match[2];
      const contextMatch = block.match(/context:\s*["']?([^\s"'#]+)["']?/) ||
        block.match(/build:\s*["']?(\.[^\s"'#{][^\s"'#]*)["']?\s*$/m);
      if (!contextMatch) continue;

      const contextPath = path.join(baseDir, contextMatch[1]);
      try {
        const stat = await fs.stat(contextPath);
        if (stat.isDirectory()) return contextPath;
      } catch (e) { /* referenced context doesn't exist on disk */ }
    }
  }
  return null;
}

// Reverse-proxy configs (e.g. an nginx "api gateway" container that fronts
// several backend services) often state, unambiguously, which URL prefix
// belongs to which backend port - `location /webapi { proxy_pass
// http://webapi:9000; }`. That's a stronger, more direct signal for "who owns
// this route prefix" than trying to infer it from what the frontend calls,
// which has no way to know that two visually unrelated prefixes (e.g. "/api"
// and "/webapi") actually belong to two entirely different backend
// processes. Returns a Map of route prefix -> port.
// docker-compose's build: declarations are the authoritative inventory of what
// this repository actually builds - including the service whose context is the
// repo ROOT, which no directory scan can ever discover (there is no
// subdirectory to find) and which is not necessarily the frontend. Only the
// compose file says whose Dockerfile that is.
//
// Returns { <compose service name>: { context: <abs path>, dockerfile } } for
// every service that declares a build context.
async function findBuildableComposeServices(baseDir) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }

    const blocks = splitComposeServiceBlocks(content);
    const out = {};
    for (const [name, block] of Object.entries(blocks)) {
      // Long form ("build:" then an indented "context:") wins over the short
      // form ("build: ./dir"), since a block carrying both is using the long one.
      const ctxMatch = block.match(/^\s*context:\s*["']?([^\s"'#]+)["']?/m);
      const shortMatch = block.match(/^\s*build:\s*["']?([^\s"'#][^\s"'#]*)["']?\s*$/m);
      const rawContext = ctxMatch ? ctxMatch[1] : (shortMatch ? shortMatch[1] : null);
      if (!rawContext) continue;

      const dfMatch = block.match(/^\s*dockerfile:\s*["']?([^\s"'#]+)["']?/m);
      out[name] = {
        context: path.resolve(baseDir, rawContext),
        dockerfile: dfMatch ? dfMatch[1] : null,
      };
    }
    return out;
  }
  return {};
}

async function findRoutePortMapFromGatewayConfig(baseDir) {
  const routePortMap = new Map();
  try {
    const allFiles = await walkDir(baseDir);
    const confFiles = allFiles.filter(f => path.extname(f) === '.conf');
    const locationRegex = /location\s+(\/[a-zA-Z0-9_\-\/]+)\/?\s*\{[^}]*?proxy_pass\s+https?:\/\/[^:\/\s]+:(\d+)/gi;

    for (const filePath of confFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        let match;
        while ((match = locationRegex.exec(content)) !== null) {
          routePortMap.set(match[1], parseInt(match[2], 10));
        }
      } catch (e) { logDebug(e); }
    }
  } catch (e) { logDebug(e); }
  return routePortMap;
}

// A "port:" key in a structured config file can belong to the server this
// service runs OR to any client it talks to, and the two are indistinguishable
// without the key's position in the document. The flat regexes below read a
// line at a time, so "spring.data.redis.port: 6379" and "spring.mail.port"
// came back as ports of the service itself - producing Service objects
// publishing a Redis port and an SMTP port that nothing in the pod listens on.
//
// Prefix guards (PG_, REDIS_, ...) cannot help here: nested YAML writes the
// component name on an enclosing line, not on the port's own.
const CLIENT_COMPONENT_KEY_REGEX = /^(redis|valkey|mongo|mongodb|datasource|jdbc|r2dbc|elasticsearch|opensearch|solr|rabbitmq|amqp|kafka|pulsar|nats|mail|smtp|imap|ftp|sftp|ldap|memcached|cassandra|influx|neo4j|etcd|consul|vault|minio|s3|eureka|zipkin|jaeger|otlp|statsd|graphite|sentry|keycloak|oauth2|clickhouse|db|database|cache|broker|queue|registry|discovery|client|proxy|upstream|remote|external)$/i;

// Key paths that really do name the port this process listens on.
const LISTEN_PORT_PATHS = [
  ['server', 'port'],
  ['port'],
  ['app', 'port'],
  ['http', 'port'],
  ['listen', 'port'],
  ['service', 'port'],
  ['web', 'port'],
  ['api', 'port'],
  ['quarkus', 'http', 'port'],
  ['micronaut', 'server', 'port'],
];

function isListenPortPath(pathParts) {
  const lower = pathParts.map(p => p.toLowerCase());
  if (lower.some(p => CLIENT_COMPONENT_KEY_REGEX.test(p))) return false;
  return LISTEN_PORT_PATHS.some(candidate =>
    candidate.length === lower.length && candidate.every((seg, i) => seg === lower[i]));
}

// Reads YAML by indentation (no parser: these files routinely contain
// placeholders and multi-document separators a strict parser rejects) and
// returns only the ports this service listens on.
function findListenPortsInYaml(content) {
  const found = new Set();
  const stack = []; // [{ indent, key }]
  for (const rawLine of content.split('\n')) {
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue;
    const m = rawLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const value = m[3].replace(/\s+#.*$/, '').trim();

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();

    // A dotted key ("spring.data.redis.port: 6379") carries its own path.
    const parts = [...stack.map(e => e.key), ...key.split('.')];
    if (parts[parts.length - 1].toLowerCase() === 'port') {
      const num = value.match(/^["']?(\d+)["']?$/);
      if (num && isListenPortPath(parts)) found.add(parseInt(num[1], 10));
    }
    if (value === '') stack.push({ indent, key });
  }
  return found;
}

// .properties / .ini / .env-style files: the whole path is on the line, so no
// indentation tracking is needed.
function findListenPortsInFlatConfig(content) {
  const found = new Set();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*["']?(\d+)["']?\s*$/);
    if (!m) continue;
    const parts = m[1].split(/[._]/);
    if (parts[parts.length - 1].toLowerCase() !== 'port') continue;
    if (parts.some(p => CLIENT_COMPONENT_KEY_REGEX.test(p))) continue;
    found.add(parseInt(m[2], 10));
  }
  return found;
}

const STRUCTURED_CONFIG_EXTENSIONS = ['.yml', '.yaml', '.properties', '.ini', '.cfg', '.conf', '.toml'];

// Prose describes the system; it does not configure it. A README with an
// architecture diagram ("Auth Service ... Port 8081", repeated for every
// service) handed the loose port regexes every port in the project at once,
// so whichever service happened to sit next to that file published a Service
// with a port for each of its siblings.
const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt'];

// The structured-config reader already refuses a port that belongs to some
// component the service TALKS TO rather than listens on (CLIENT_COMPONENT_KEY_
// REGEX). The line-oriented regexes below had only a short hardcoded list of
// prefixes to guard against, so a name like DD_TRACE_AGENT_PORT=8126 in a
// Dockerfile - the Datadog agent's port, not the app's - came back as the
// service's own listen port, on every service that instruments itself.
const CLIENT_PORT_CONTEXT_REGEX = /\b(dd|datadog|trace|apm|agent|statsd|otlp|jaeger|zipkin|redis|valkey|mongo|mongodb|mysql|postgres|postgresql|pg|mariadb|rabbit|rabbitmq|amqp|kafka|pulsar|nats|memcached?|elastic|elasticsearch|opensearch|solr|smtp|mail|imap|ldap|consul|vault|etcd|eureka|zookeeper|influx|influxdb|clickhouse|cassandra|neo4j|minio|sentry|grafana|prometheus|loki|tempo|db|database)[_-]/i;

// A test's ports are the ports of whatever the test stands up - an embedded
// broker, a fake SMTP server, a testcontainer - never the ports the service
// itself listens on in production. Reading them produced Service objects
// publishing e.g. port 25 because an integration test pinned
// "spring.mail.port" to it.
const TEST_PATH_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration-test', 'it', 'testing', 'fixtures', 'mocks', '__mocks__']);

function isTestPath(relativePath) {
  return relativePath.split(path.sep).some(seg => TEST_PATH_SEGMENTS.has(seg.toLowerCase()));
}

async function findPortsInDir(baseDir, targetDir, portNamesPattern, defaultPort, excludeDirNames = []) {
  const regexList = [
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?<!PG_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)(?:${portNamesPattern})\\s*[:=]\\s*["']?(\\d+)["']?`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?:process\\.env\\.)?(?<!PG_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)(?:${portNamesPattern})\\s*\\|\\|\\s*(\\d+)`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?<!PG_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)port\\s*[:=]\\s*["']?(\\d+)["']?`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*--inspect(?:-brk)?=(?:[^:]+:)?(\\d+)`, 'gim'),
    new RegExp(`(?:^|\\s)(?:--port|-p)\\s*[=:]?\\s*(\\d+)`, 'gim'),
    new RegExp(`(?<!PG_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)\\bport\\b.{0,15}?(?<![a-zA-Z0-9.-])(\\d{2,5})\\b`, 'gim'),
    new RegExp(`^\\s*EXPOSE\\s+(\\d+)`, 'gim')
  ];

  let filesToScan = await walkDir(targetDir);

  // When targetDir *is* the repo root (a backend with no dedicated
  // subdirectory - its Dockerfile sits at the root itself), walking it also
  // walks straight into sibling services like frontend/ that just happen to
  // live underneath the same root. Exclude their top-level directory names so
  // a frontend's own port declarations don't get attributed to the backend.
  if (excludeDirNames.length > 0) {
    filesToScan = filesToScan.filter(f => {
      const rel = path.relative(targetDir, f);
      const firstSegment = rel.split(path.sep)[0];
      return !excludeDirNames.includes(firstSegment);
    });
  }

  filesToScan = filesToScan.filter(f => !isTestPath(path.relative(targetDir, f)));

  // Also scan base dir .env files if they exist and aren't already in targetDir
  if (baseDir !== targetDir) {
    try {
      const baseFiles = await fs.readdir(baseDir);
      for (const file of baseFiles) {
        if (file.startsWith('.env')) {
          filesToScan.push(path.join(baseDir, file));
        }
      }
    } catch (e) { }
  }

  const ports = new Set();

  for (const filePath of filesToScan) {
    try {
      const content = await fs.readFile(filePath, 'utf8');

      const ext = path.extname(filePath).toLowerCase();
      if (DOCUMENTATION_EXTENSIONS.includes(ext)) continue;

      // Structured config carries the component each port belongs to in the
      // key path, so it is read structurally instead of line-by-line.
      if (STRUCTURED_CONFIG_EXTENSIONS.includes(ext)) {
        const structured = (ext === '.yml' || ext === '.yaml')
          ? findListenPortsInYaml(content)
          : findListenPortsInFlatConfig(content);
        for (const p of structured) {
          if (p > 0 && p <= 65535) ports.add(p);
        }
        continue;
      }

      for (const regex of regexList) {
        const matches = [...content.matchAll(regex)];
        for (const match of matches) {
          if (match[1]) {
            // The matched text carries the variable name the port was read
            // from; when that names another component, it is that
            // component's port, not this service's. A bare "port=8126," in a
            // client's constructor names nothing on its own line, so the two
            // lines above it are considered as well - that is where the
            // client being configured is spelled out ("tracer.configure(",
            // "hostname='dd-agent'").
            const lineStart = content.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
            let contextStart = lineStart;
            for (let back = 0; back < 2 && contextStart > 0; back++) {
              contextStart = content.lastIndexOf('\n', contextStart - 2) + 1;
            }
            const contextText = content.slice(contextStart, match.index + match[0].length);
            if (CLIENT_PORT_CONTEXT_REGEX.test(contextText)) continue;
            const portNum = parseInt(match[1], 10);
            // Valid port range
            if (portNum > 0 && portNum <= 65535) {
              ports.add(portNum);
            }
          }
        }
      }
    } catch (e) { }
  }

  return ports.size > 0 ? Array.from(ports) : [defaultPort];
}

// Suffixes that mark a Dockerfile as built for tests/CI only, never as the
// thing that actually serves production traffic - e.g. "Dockerfile.playwright"
// spins up a Playwright E2E test runner, not a web server. Without this,
// findDockerfile's partial-match fallback would happily pick that file as
// "the" frontend production image whenever a plain Dockerfile is missing.
const NON_PRODUCTION_DOCKERFILE_HINTS = ['playwright', 'cypress', 'e2e', 'selenium', 'test', 'ci', 'dev', 'debug', 'lint', 'sonar'];

async function findDockerfile(dir) {
  try {
    const files = await fs.readdir(dir);
    const exactMatch = files.find(f => f.toLowerCase() === 'dockerfile');
    if (exactMatch) return exactMatch;

    const candidates = files.filter(f => f.toLowerCase() !== 'dockerfile' && f.toLowerCase().includes('dockerfile'));
    const productionCandidates = candidates.filter(f => {
      const lower = f.toLowerCase();
      return !NON_PRODUCTION_DOCKERFILE_HINTS.some(hint => lower.includes(hint));
    });
    if (productionCandidates.length > 0) return productionCandidates[0];
  } catch(e) { logDebug(e); }
  return null;
}

// The single most reliable statement of a service's health endpoint is the
// one its author already wrote in docker-compose:
//   healthcheck:
//     test: ["CMD-SHELL", "wget -q --spider http://localhost:8080/actuator/health || exit 1"]
// findHealthRoute only ever looked for a quoted "/health"-style literal in
// source code, so every service whose health endpoint is provided by a
// framework (Spring Actuator, Micronaut, Quarkus) rather than written by hand
// got no probe at all - a crashed process stayed in the Service's endpoints
// and kept receiving traffic.
function findHealthCheckInComposeBlock(serviceBlock) {
  if (!serviceBlock) return null;
  const healthcheckIdx = serviceBlock.search(/^\s*healthcheck:/m);
  if (healthcheckIdx === -1) return null;
  const section = serviceBlock.slice(healthcheckIdx);
  // Only an HTTP probe maps to a Kubernetes httpGet probe; "pg_isready" and
  // friends are exec probes the database templates already handle.
  const urlMatch = section.match(/https?:\/\/[^\s"'\\]*?(?::(\d+))?(\/[^\s"'\\|)]*)/i);
  if (!urlMatch) return null;
  const route = urlMatch[2];
  if (!route || route === '/') return { route: '/', port: urlMatch[1] ? parseInt(urlMatch[1], 10) : null };
  return { route: route.replace(/[?#].*$/, ''), port: urlMatch[1] ? parseInt(urlMatch[1], 10) : null };
}

async function findHealthCheckFromCompose(baseDir, serviceNames) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }
    const blocks = splitComposeServiceBlocks(content);
    for (const name of serviceNames) {
      if (!name) continue;
      const found = findHealthCheckInComposeBlock(blocks[name]);
      if (found) return found;
    }
    return null;
  }
  return null;
}

// Spring Boot Actuator, Micronaut and Quarkus all ship a health endpoint at a
// fixed, conventional path as soon as the dependency is present - no route is
// ever written in the project's own source for findHealthRoute to find.
const FRAMEWORK_HEALTH_MARKERS = [
  { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], marker: /spring-boot-starter-actuator/i, route: '/actuator/health' },
  { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], marker: /micronaut-management/i, route: '/health' },
  { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], marker: /quarkus-smallrye-health/i, route: '/q/health' },
];

async function findFrameworkHealthRoute(servicePath) {
  if (!servicePath) return null;
  for (const entry of FRAMEWORK_HEALTH_MARKERS) {
    for (const file of entry.files) {
      let content;
      try {
        content = await fs.readFile(path.join(servicePath, file), 'utf8');
      } catch (e) { continue; }
      if (!entry.marker.test(content)) continue;

      // Actuator's base path is configurable; honour it rather than assuming.
      if (entry.route === '/actuator/health') {
        const configured = await findActuatorBasePath(servicePath);
        if (configured) return `${configured.replace(/\/$/, '')}/health`;
      }
      return entry.route;
    }
  }
  return null;
}

async function findActuatorBasePath(servicePath) {
  const files = await walkDir(servicePath);
  for (const file of files) {
    const base = path.basename(file);
    if (!/^application(-\w+)?\.(properties|ya?ml)$/.test(base)) continue;
    if (isTestPath(path.relative(servicePath, file))) continue;
    try {
      const content = await fs.readFile(file, 'utf8');
      const flat = content.match(/management\.endpoints\.web\.base-path\s*[:=]\s*["']?([^\s"']+)/);
      if (flat) return flat[1];
      const nested = content.match(/^\s*base-path:\s*["']?([^\s"']+)/m);
      if (nested && /management:/.test(content)) return nested[1];
    } catch (e) { logDebug(e); }
  }
  return null;
}

// A controller routinely declares its health endpoint relative to a prefix
// mounted on the whole class - Spring's class-level @RequestMapping("/api"),
// NestJS's @Controller('api'), an Express router mounted with
// app.use('/api', ...). Reading only the method-level literal produced
// "/health" for an endpoint that actually answers at "/api/health", so the
// startup probe got a 404 and Kubernetes killed the container in a loop: the
// application was healthy the whole time, the probe was pointed at nothing.
function findMountPrefixForHealth(content, ext) {
  if (ext === '.java') {
    // @RequestMapping on the class itself, i.e. the annotation that sits
    // immediately before the class declaration (any number of other
    // annotations may be interleaved).
    const m = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)[\s\S]{0,400}?\bclass\s+\w/);
    if (m) return m[1];
    return null;
  }
  if (ext === '.ts' || ext === '.js') {
    // NestJS controller prefix.
    const nest = content.match(/@Controller\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (nest) return nest[1].startsWith('/') ? nest[1] : '/' + nest[1];
    return null;
  }
  if (ext === '.py') {
    // Flask blueprint / FastAPI router prefix.
    const m = content.match(/url_prefix\s*=\s*["']([^"']+)["']/) ||
      content.match(/APIRouter\s*\([^)]*prefix\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
    return null;
  }
  return null;
}

async function findHealthRoute(backendPath, excludeDirNames = []) {
  const possibleRoutes = ['\\/healthz', '\\/health-check', '\\/healthcheck', '\\/health', '\\/ping', '\\/status', '\\/ready', '\\/live'];
  // Capture the WHOLE literal, not just its tail: a route written as
  // "/api/health" must come back as "/api/health". Allow a trailing slash
  // before the closing quote - frameworks like FastAPI commonly declare
  // routes as e.g. "/health-check/".
  const regex = new RegExp(`['"\`]((?:\\/[A-Za-z0-9_.-]+)*?(?:${possibleRoutes.join('|')}))\\/?['"\`]`, 'i');

  let filesToScan = await walkDir(backendPath);
  if (excludeDirNames.length > 0) {
    filesToScan = filesToScan.filter(f => {
      const rel = path.relative(backendPath, f);
      const firstSegment = rel.split(path.sep)[0];
      return !excludeDirNames.includes(firstSegment);
    });
  }

  for (const filePath of filesToScan) {
    const ext = path.extname(filePath);
    if (!['.js', '.ts', '.go', '.py', '.java', '.cs', '.php'].includes(ext)) continue;
    if (isTestPath(path.relative(backendPath, filePath))) continue;
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const match = regex.exec(content);
      if (!match || !match[1]) continue;

      let route = match[1];
      const prefix = findMountPrefixForHealth(content, ext);
      if (prefix && prefix !== '/' && !route.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) {
        route = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix) + route;
      }
      return route.startsWith('/') ? route : '/' + route;
    } catch(e) { logDebug(e); }
  }
  
  return null; // Fallback
}

// Well-known infrastructure/plumbing component names that happen to contain
// "server"/"app" but are never the project's actual business-logic backend
// (e.g. Spring Cloud's config-server, service registries, discovery servers).
// Without this, the substring match below picks "config-server" over real
// service directories just because it contains "server".
const NON_BUSINESS_BACKEND_DIRS = ['config-server', 'config server', 'configserver', 'eureka-server', 'eureka server', 'discovery-server', 'discovery server', 'service-registry', 'registry-server', 'naming-server', 'zookeeper', 'consul-server'];

async function analyzeBackend(baseDir) {
  const exactDirs = ['api', 'backend', 'server'];
  const partialDirs = ['api', 'backend', 'server', 'app'];
  let backendPath = null;

  // 0. A docker-compose service literally named "api"/"backend"/"server" is
  // ground truth for which directory the project itself considers "the"
  // backend - check it before any directory-name guessing. Without this, two
  // sibling directories that both happen to contain "api" as a substring
  // (e.g. "javaapi" and "nodeapi") are indistinguishable to steps 1-2 below,
  // which then pick whichever one readdir() happens to list first - with no
  // relation to which one the project's own compose file calls "api".
  const composeContext = await findServiceContextFromCompose(baseDir, exactDirs);
  if (composeContext && await findDockerfile(composeContext)) {
    backendPath = composeContext;
  }

  // 1. Try exact match first - only accept a candidate that actually has its
  // own Dockerfile. Otherwise Flarops would generate a werf.yaml image block
  // pointing at a Dockerfile that doesn't exist (e.g. a directory literally
  // named "api" that's built by some other, non-per-service mechanism).
  if (!backendPath) {
    for (const dir of exactDirs) {
      const fullPath = path.join(baseDir, dir);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory() && await findDockerfile(fullPath)) {
          backendPath = fullPath;
          break;
        }
      } catch (err) { }
    }
  }

  // 2. Fallback to partial match (e.g., 'kanban-app', 'my-api')
  if (!backendPath) {
    try {
      const files = await fs.readdir(baseDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
          const lowerName = file.name.toLowerCase();
          // Avoid matching frontend folders as backend
          if (['ui', 'frontend', 'client', 'web', 'front'].some(k => lowerName.includes(k))) continue;
          // Avoid matching infrastructure/plumbing services as "the" backend
          if (NON_BUSINESS_BACKEND_DIRS.some(k => lowerName.includes(k))) continue;

          if (partialDirs.some(k => lowerName.includes(k))) {
            const candidate = path.join(baseDir, file.name);
            if (await findDockerfile(candidate)) {
              backendPath = candidate;
              break;
            }
          }
        }
      }
    } catch (err) { logDebug(err); }
  }

  // 3. Last resort: some projects put the backend's Dockerfile directly at
  // the repo root, with the actual application package living in a
  // same-named subdirectory that has no Dockerfile of its own (e.g. a Django
  // project's manage.py/requirements.txt/Dockerfile all sitting at the root,
  // next to a "backend/" package folder that's just settings.py/urls.py/
  // wsgi.py - no Dockerfile in sight). Steps 1 and 2 only ever look inside
  // subdirectories, so this layout was invisible to them entirely. Only do
  // this when the root Dockerfile doesn't look like it merely serves static
  // frontend assets (nginx/httpd/caddy/apache) - that shape is far more
  // likely a frontend-only repo than an unconventional backend layout.
  if (!backendPath) {
    const rootDockerfile = await findDockerfile(baseDir);
    if (rootDockerfile) {
      let isStaticFrontend = false;
      try {
        const content = await fs.readFile(path.join(baseDir, rootDockerfile), 'utf8');
        const stages = content.split(/FROM\s+/i);
        const lastStageBaseImage = stages[stages.length - 1].split('\n')[0];
        isStaticFrontend = /nginx|httpd|caddy|apache/i.test(lastStageBaseImage);
      } catch (e) { logDebug(e); }

      if (!isStaticFrontend) {
        backendPath = baseDir;
      }
    }
  }

  if (!backendPath) {
    return { hasBackend: false, backendPath: null, port: 3000, healthRoute: null };
  }

  // Only relevant when backendPath fell back to the repo root itself (step 3
  // above) - a backend living in its own subdirectory never contains a
  // sibling frontend/ to begin with, so this is a no-op in every other case.
  const scanExcludeDirNames = backendPath === baseDir ? ['frontend', 'client', 'ui', 'web', 'front'] : [];

  const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'BACKEND_PORT', 'LISTEN_PORT', 'NODE_PORT', 'SERVICE_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, backendPath, portNamesPattern, 3000, scanExcludeDirNames);
  const composePorts = await findPortsInCompose(baseDir, [...partialDirs, path.basename(backendPath)]);

  const dockerfile = await findDockerfile(backendPath);
  // Most authoritative first: the probe the compose author actually wrote,
  // then a framework's conventional endpoint, then a route literal in source.
  const composeHealth = await findHealthCheckFromCompose(baseDir, [path.basename(backendPath), ...partialDirs]);
  const healthRoute = (composeHealth && composeHealth.route)
    || await findFrameworkHealthRoute(backendPath)
    || await findHealthRoute(backendPath, scanExcludeDirNames);
  const healthPort = composeHealth ? composeHealth.port : null;
  const needsRootContext = dockerfile ? await dockerfileNeedsRootContext(baseDir, backendPath, dockerfile) : false;

  if (dirPorts.length === 1 && dirPorts[0] === 3000 && composePorts.length > 0) {
    return { hasBackend: true, backendPath, ports: composePorts, dockerfile, healthRoute, healthPort, needsRootContext };
  }

  const ports = Array.from(new Set([...dirPorts, ...composePorts]));
  return { hasBackend: true, backendPath, ports, dockerfile, healthRoute, healthPort, needsRootContext };
}

async function inferFrontendPortFromPackage(frontendPath) {
  try {
    const allFiles = await walkDir(frontendPath);
    const packageFiles = allFiles.filter(f => path.basename(f) === 'package.json');

    for (const pkgPath of packageFiles) {
      try {
        const content = await fs.readFile(pkgPath, 'utf8');
        const pkg = JSON.parse(content);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        if (deps['react-scripts']) return 3000;
        if (deps['next']) return 3000;
        if (deps['nuxt']) return 3000;
        if (deps['@angular/cli']) return 4200;
        if (deps['vite']) return 5173;
        if (deps['@vue/cli-service']) return 8080;
        if (deps['gatsby']) return 8000;
        if (deps['svelte'] || deps['@sveltejs/kit']) return 5173;
      } catch (e) { logDebug(e); }
    }
  } catch (e) { }
  // No package.json, or none of its dependencies matched a known frontend
  // framework (e.g. a non-JS app, like a Go binary serving its own static
  // UI) - there's no real signal here at all, so don't invent one. Returning
  // 80 unconditionally used to make this look exactly like a confident
  // "static frontend on nginx" detection to every caller, letting it
  // silently outrank an actually-detected port (e.g. from docker-compose)
  // wherever the two were merged.
  return null;
}

async function analyzeDockerfile(frontendPath) {
  try {
    const targetDockerfile = await findDockerfile(frontendPath);
    if (!targetDockerfile) return null;
    
    const dockerfilePath = path.join(frontendPath, targetDockerfile);
    const content = await fs.readFile(dockerfilePath, 'utf8');
    
    const stages = content.split(/FROM\s+/i);
    if (stages.length > 1) {
      const lastStage = stages[stages.length - 1];
      
      const exposeMatch = /EXPOSE\s+(\d+)/i.exec(lastStage);
      if (exposeMatch) {
        return parseInt(exposeMatch[1], 10);
      }
      
      const baseImageLine = lastStage.split('\n')[0];
      if (/nginx|httpd|caddy|apache/i.test(baseImageLine)) {
        return 80;
      }
    }
  } catch (e) { logDebug(e); }
  
  return null;
}

async function scoreFrontend(fullPath) {
  let score = 0;
  
  try {
    const pkgPath = path.join(fullPath, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps['react'] || deps['vue'] || deps['@angular/core'] || deps['next'] || deps['nuxt'] || deps['svelte']) {
       score += 10;
    }
  } catch(e) {}
  
  try {
    const dirFiles = await walkDir(fullPath);
    const hasIndexHtml = dirFiles.some(f => path.basename(f).toLowerCase() === 'index.html');
    if (hasIndexHtml) score += 5;
  } catch(e) {}
  
  if (['vote', 'main', 'app', 'client'].includes(path.basename(fullPath).toLowerCase())) {
    score += 2;
  }
  
  return score;
}

async function analyzeFrontend(baseDir, backendPath = null) {
  const exactDirs = ['frontend', 'client', 'ui', 'web', 'front'];
  let frontendPath = null;
  let composeDockerfile = null;

  // 0. If docker-compose names a frontend service, its build context IS the
  // frontend - wherever it points. Every step below only ever looks at
  // SUBDIRECTORIES, so a frontend built from the repo root (a very common
  // Vite/Next layout: package.json and Dockerfile at the top, sources under
  // client/) was invisible and the whole frontend silently dropped out of the
  // deployment. The compose file is also the only thing that can say whose
  // Dockerfile the root one is - it is not necessarily the frontend's.
  {
    const composeBuilds = await findBuildableComposeServices(baseDir);
    for (const name of Object.keys(composeBuilds)) {
      const lower = name.toLowerCase();
      if (!exactDirs.includes(lower) && !exactDirs.some(k => lower.includes(k))) continue;
      const candidate = composeBuilds[name].context;
      if (backendPath && path.resolve(candidate) === path.resolve(backendPath)) continue;
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) continue;
      } catch (e) { continue; }
      if (!(await findDockerfile(candidate)) && !composeBuilds[name].dockerfile) continue;
      frontendPath = candidate;
      composeDockerfile = composeBuilds[name].dockerfile;
      break;
    }
  }

  // 1. Try exact match first - only accept a candidate that actually has its
  // own Dockerfile, otherwise Flarops would generate a werf.yaml image block
  // pointing at a Dockerfile that doesn't exist.
  for (const dir of exactDirs) {
    const fullPath = path.join(baseDir, dir);
    if (fullPath === backendPath) continue;
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && await findDockerfile(fullPath)) {
        frontendPath = fullPath;
        break;
      }
    } catch (err) { logDebug(err); }
  }

  // 2. Fallback to partial match
  if (!frontendPath) {
    try {
      const files = await fs.readdir(baseDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
          const lowerName = file.name.toLowerCase();
          const fullPath = path.join(baseDir, file.name);
          if (fullPath === backendPath) continue;
          if (exactDirs.some(k => lowerName.includes(k)) && await findDockerfile(fullPath)) {
            frontendPath = fullPath;
            break;
          }
        }
      }
    } catch (err) { logDebug(err); }
  }

  // 3. Fallback: heuristic scoring of directories with Dockerfile
  if (!frontendPath) {
    try {
      let bestScore = 0;
      let bestDir = null;

      const files = await fs.readdir(baseDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isDirectory() || file.name.startsWith('.') || file.name === 'node_modules') continue;
        if (SERVICE_SCAN_IGNORED_DIRS.has(file.name)) continue;
        const fullPath = path.join(baseDir, file.name);
        if (fullPath === backendPath) continue;

        const df = await findDockerfile(fullPath);
        if (!df) continue; // must be a deployable service

        const score = await scoreFrontend(fullPath);

        if (score > bestScore) {
          bestScore = score;
          bestDir = fullPath;
        }
      }

      if (bestScore > 0) {
        frontendPath = bestDir;
      }
    } catch(e) { logDebug(e); }
  }

  if (!frontendPath) {
    return { hasFrontend: false, frontendPath: null, port: 80 };
  }

  const inferredPort = await inferFrontendPortFromPackage(frontendPath);
  const dockerfilePort = await analyzeDockerfile(frontendPath);

  // dockerfilePort/inferredPort are real, specific signals (an EXPOSE line, a
  // recognized frontend framework's own dev-server port convention) - a
  // fixed 80 fallback used to masquerade as one of these even when neither
  // fired, silently outranking an actually-detected compose/env port below.
  // Only fall back to 80 once every other signal, including the ones found
  // further down, comes up empty.
  const primaryPort = dockerfilePort !== null ? dockerfilePort : inferredPort;

  const portNamesPattern = ['PORT', 'FRONTEND_PORT', 'VITE_PORT', 'REACT_APP_PORT', 'NUXT_PORT'].join('|');
  // Passing a hardcoded 80 here as "the" default reintroduces the exact
  // problem above one level down: findPortsInDir returns it verbatim as a
  // "found" port whenever its own regex scan comes up empty, indistinguishable
  // from a real detection - so it would still end up ranked ahead of a
  // genuinely-detected compose port. Pass null instead so an empty scan stays
  // empty; the actual fallback to 80 only happens once, below, if nothing at
  // all was found anywhere.
  // When the frontend's build context IS the repo root, scanning it walks
  // straight through every sibling service's source as well, and their listen
  // ports come back as the frontend's own. Exclude the top-level directory
  // each OTHER buildable service lives under.
  const frontendScanExcludes = [];
  if (path.resolve(frontendPath) === path.resolve(baseDir)) {
    const composeBuilds = await findBuildableComposeServices(baseDir);
    for (const info of Object.values(composeBuilds)) {
      const rel = path.relative(baseDir, info.context);
      if (!rel || rel.startsWith('..')) continue; // this service IS the root
      frontendScanExcludes.push(rel.split(path.sep)[0]);
    }
    if (backendPath) {
      const rel = path.relative(baseDir, backendPath);
      if (rel && !rel.startsWith('..')) frontendScanExcludes.push(rel.split(path.sep)[0]);
    }
  }

  const dirPorts = (await findPortsInDir(baseDir, frontendPath, portNamesPattern, primaryPort, frontendScanExcludes)).filter(p => p !== null);
  const composePorts = await findPortsInCompose(baseDir, [...exactDirs, path.basename(frontendPath)]);

  // A compose-declared dockerfile name wins: findDockerfile only guesses, and
  // when the context is the repo root there are often several Dockerfiles
  // around to guess wrongly between.
  const dockerfile = composeDockerfile || await findDockerfile(frontendPath);
  const needsRootContext = dockerfile ? await dockerfileNeedsRootContext(baseDir, frontendPath, dockerfile) : false;

  if (primaryPort !== null && dirPorts.length === 1 && dirPorts[0] === primaryPort && composePorts.length > 0) {
    return { hasFrontend: true, frontendPath, ports: Array.from(new Set([primaryPort, ...composePorts])), dockerfile, needsRootContext };
  }

  const knownPorts = [primaryPort, ...dirPorts, ...composePorts].filter(p => p !== null);
  const ports = knownPorts.length > 0 ? Array.from(new Set(knownPorts)) : [80];
  return { hasFrontend: true, frontendPath, ports, dockerfile, needsRootContext };
}


// excludeDirNames matters when serviceDir IS the repository root (a service
// whose docker-compose build context is "."): without it the scan walks every
// sibling service's source too, and their secrets are reported as this
// service's - which is how a static frontend ended up being handed the
// database password.
async function extractUsedEnvVars(serviceDir, excludeDirNames = []) {
  const { walkDir, logDebug } = require('./fsHelper');
  const envVars = new Set();
  
  if (!serviceDir) return Array.from(envVars);

  try {
    let files = await walkDir(serviceDir);
    if (excludeDirNames.length > 0) {
      files = files.filter(f => {
        const rel = path.relative(serviceDir, f);
        return !excludeDirNames.includes(rel.split(path.sep)[0]);
      });
    }
    const envVarRegex = /(?:process\.env\.|process\.env\[['"`]|os\.Getenv\(['"`]|getenv\(['"`]|System\.getenv\(['"`]|Environment\.GetEnvironmentVariable\(['"`]\$?|\$ENV\[['"`]|\$_ENV\[['"`]|\$\b)([a-zA-Z_][a-zA-Z0-9_]+)/g;
    const destructureRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;

    // Python's os.environ (both subscript and .get) and Ruby's ENV - neither
    // is spelled like any of the call forms above, so every Python/Ruby
    // service previously looked like it read no environment at all.
    const pythonRubyEnvRegex = /(?:os\.environ(?:\.get)?\s*[[(]\s*['"]|\bENV\s*(?:\.fetch\s*\(\s*)?\[?\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g;
    // Go struct tags: `env:"DB_HOST"` / `envconfig:"DB_HOST"` - the whole
    // point of those libraries is that there is no Getenv call to find.
    const goStructTagRegex = /\b(?:env|envconfig)\s*:\s*"([A-Z_][A-Z0-9_]*)"/g;

    for (const file of files) {
      if (file.includes('node_modules') || file.includes('.git') || file.includes('dist') || file.includes('build')) continue;
      try {
        // `fs` here is `require('fs').promises`, which has no readFileSync -
        // calling it threw silently into the catch below on every single
        // file, so this function always returned an empty list regardless of
        // project or language. That meant every downstream consumer (which
        // secrets actually get wired as container env vars) silently saw "no
        // env vars are used anywhere", for every project.
        const fileContent = await fs.readFile(file, 'utf8');

        let match;
        while ((match = envVarRegex.exec(fileContent)) !== null) {
          envVars.add(match[1]);
        }
        
        let destructureMatch;
        while ((destructureMatch = destructureRegex.exec(fileContent)) !== null) {
          const keys = destructureMatch[1].split(',').map(k => k.split(':')[0].split('=')[0].trim()).filter(k => k);
          for (const key of keys) {
            envVars.add(key);
          }
        }

        while ((match = pythonRubyEnvRegex.exec(fileContent)) !== null) {
          envVars.add(match[1]);
        }

        if (file.endsWith('.go')) {
          while ((match = goStructTagRegex.exec(fileContent)) !== null) {
            envVars.add(match[1]);
          }
        }

        // Spring Boot (and anything else using the same placeholder syntax)
        // resolves ${DB_PASSWORD} / ${DB_HOST:localhost} straight out of the
        // environment from a config FILE - there is no call anywhere in the
        // Java source to find. Without this, a Spring service reported zero
        // used env vars, so every secret it needs was collected into
        // deploy/.env and GitHub Secrets but never wired into the container,
        // and the app died at startup on an unresolvable placeholder.
        const base = path.basename(file);
        if (/^application(-[\w.]+)?\.(ya?ml|properties)$/.test(base) || /^bootstrap(-[\w.]+)?\.(ya?ml|properties)$/.test(base)) {
          const springPlaceholderRegex = /\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?::[^}]*)?\}/g;
          let springMatch;
          while ((springMatch = springPlaceholderRegex.exec(fileContent)) !== null) {
            // Spring's own relaxed-binding names (spring.datasource.url) are
            // properties, not environment variables; only the SCREAMING_SNAKE
            // form is something the container can actually be given.
            const name = springMatch[1];
            if (/^[A-Z][A-Z0-9_]*$/.test(name)) envVars.add(name);
          }
        }

        // Python's pydantic-settings (and plain pydantic BaseSettings before
        // it) never calls os.getenv()/os.environ[] at all - a class field
        // like "SECRET_KEY: str" inside a `class Settings(BaseSettings):` is
        // automatically populated from the identically-named environment
        // variable purely by field name. None of the call-based patterns
        // above can see that, so every such field silently looked "unused"
        // and never got wired into the container's env at all.
        if (file.endsWith('.py') && /from\s+pydantic(?:_settings)?\s+import[^\n]*BaseSettings|class\s+\w+\s*\(\s*BaseSettings\s*\)/.test(fileContent)) {
          const pydanticFieldRegex = /^[ \t]+([A-Z][A-Z0-9_]*)\s*:\s*\S/gm;
          let fieldMatch;
          while ((fieldMatch = pydanticFieldRegex.exec(fileContent)) !== null) {
            envVars.add(fieldMatch[1]);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  
  return Array.from(envVars);
}

// True if `servicePath` is a module of a Maven multi-module reactor rooted at
// `baseDir` (a root pom.xml with <packaging>pom</packaging> that lists this
// directory under <modules>). Such a module's own pom.xml inherits <parent>
// from the root pom, which Maven resolves via the default "../pom.xml"
// relative lookup - so the module can only be built with the *repo root* as
// Docker build context (not the module's own directory, which wouldn't
// include the parent pom at all).
// True if `dockerfileName` (inside `servicePath`) has a COPY/ADD instruction
// whose source only exists relative to the repo root (`baseDir`), not
// relative to the service's own directory - e.g. a backend Dockerfile that
// also builds and embeds a sibling frontend/ directory into the same image
// (a common monorepo pattern). Such a Dockerfile can only be built with the
// repo root as Docker build context; using the service's own directory as
// context would make those COPY sources unreachable and the build would fail.
async function dockerfileNeedsRootContext(baseDir, servicePath, dockerfileName) {
  try {
    let content = await fs.readFile(path.join(servicePath, dockerfileName), 'utf8');
    content = content.replace(/\\\r?\n[ \t]*/g, ' '); // join line continuations
    const lines = content.split('\n');

    for (const line of lines) {
      const instrMatch = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
      if (!instrMatch) continue;
      const instruction = instrMatch[2];
      if (/--from=/i.test(instruction)) continue; // inter-stage copy, not a host path

      const tokens = instruction.trim().split(/\s+/).filter(t => t && !t.startsWith('--'));
      if (tokens.length < 2) continue;
      const sources = tokens.slice(0, -1); // last token is the destination

      for (let source of sources) {
        if (/^https?:\/\//i.test(source)) continue; // ADD <url>
        source = source.replace(/^\.\//, '');
        if (source === '.' || source === '') continue;

        const existsOwnDir = await fs.access(path.join(servicePath, source)).then(() => true).catch(() => false);
        if (existsOwnDir) continue;

        const existsAtRoot = await fs.access(path.join(baseDir, source)).then(() => true).catch(() => false);
        if (existsAtRoot) return true;
      }
    }
  } catch (e) { logDebug(e); }
  return false;
}

async function isMavenReactorModule(baseDir, servicePath) {
  try {
    const rootPomContent = await fs.readFile(path.join(baseDir, 'pom.xml'), 'utf8');
    if (!/<packaging>\s*pom\s*<\/packaging>/i.test(rootPomContent)) return false;
    const moduleName = path.basename(servicePath);
    const moduleRegex = new RegExp(`<module>\\s*${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</module>`, 'i');
    return moduleRegex.test(rootPomContent);
  } catch (e) {
    return false;
  }
}

// Flarops copies its own Go dashboard into the target repo. Once generated it
// lives under deploy/ (already ignored), but when Flarops runs against its own
// source tree the copy sits at dashboard/ - recognised here by its module
// path rather than by blacklisting the name "dashboard", which is an entirely
// reasonable name for a user's own service.
async function isFlaropsOwnDashboard(servicePath) {
  try {
    const goMod = await fs.readFile(path.join(servicePath, 'go.mod'), 'utf8');
    return /module\s+github\.com\/devforth\/flarops/.test(goMod);
  } catch (e) {
    return false;
  }
}

// Builds one service entry. Kept separate from discovery so a service found
// via docker-compose (possibly nested under services/, or built from the repo
// root) is analysed exactly the same way as one found by scanning directories.
// Top-level directory names that belong to some OTHER buildable service.
// Needed whenever a service's own context is the repository root, so scans
// rooted there don't absorb their siblings' ports, env vars and secrets.
async function rootContextExcludes(baseDir, claimedPaths = []) {
  const excludes = new Set();
  let composeBuilds = {};
  try {
    composeBuilds = await findBuildableComposeServices(baseDir);
  } catch (e) { logDebug(e); }
  const add = (p) => {
    const rel = path.relative(baseDir, p);
    if (rel && !rel.startsWith('..')) excludes.add(rel.split(path.sep)[0]);
  };
  for (const info of Object.values(composeBuilds)) add(info.context);
  for (const p of claimedPaths) if (p) add(p);
  return Array.from(excludes);
}

async function buildServiceEntry(baseDir, dirPath, name, composeNames, siblingExcludes, composeDockerfile) {
  // A compose service names its OWN Dockerfile, and several services routinely
  // share one build context with a different one each ("Dockerfile.api" and
  // "Dockerfile.worker" over the same ./app). findDockerfile can only ever
  // return one of them, so the compose declaration wins whenever there is one.
  const dockerfile = composeDockerfile || await findDockerfile(dirPath);
  if (!dockerfile) return null;
  if (await isFlaropsOwnDashboard(dirPath)) return null;

  const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'SERVICE_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, dirPath, portNamesPattern, null, siblingExcludes || []);
  const composePorts = await findPortsInCompose(baseDir, composeNames);

  let ports = Array.from(new Set([...dirPorts, ...composePorts])).filter(p => p !== null);
  if (ports.length === 0) ports = [80]; // fallback

  const composeHealth = await findHealthCheckFromCompose(baseDir, composeNames);
  const healthRoute = (composeHealth && composeHealth.route)
    || await findFrameworkHealthRoute(dirPath)
    || await findHealthRoute(dirPath);
  const healthPort = composeHealth ? composeHealth.port : null;
  const usedEnvVars = await extractUsedEnvVars(dirPath, siblingExcludes || []);

  const { analyzeBackendExposedRoutes } = require('./routeAnalyzer');
  const exposedRoutes = await analyzeBackendExposedRoutes(dirPath);
  const isReactorModule = await isMavenReactorModule(baseDir, dirPath);

  return {
    name,
    // init.js sanitizes `name` into an RFC-1123 k8s name ("My_Service" ->
    // "my-service"), after which matching it against a raw docker-compose
    // service key silently stopped working and that service's whole
    // environment: block was dropped. Keep the original spelling so the
    // compose scan can still recognise it.
    originalName: name,
    // The compose key can differ from the directory name entirely (a service
    // in services/auth-service declared as "auth", say), and it is what every
    // env/depends_on lookup in init.js keys off.
    composeName: composeNames.find(n => n !== name) || name,
    path: dirPath,
    ports,
    healthRoute,
    healthPort,
    usedEnvVars,
    dockerfile,
    exposedRoutes,
    isMavenReactorModule: isReactorModule,
  };
}

async function analyzeAdditionalServices(baseDir, knownPaths) {
  const services = [];
  const claimed = new Set((knownPaths || []).filter(Boolean).map(p => path.resolve(p)));
  const seen = new Set();
  const candidates = [];

  // Identity is the (context, dockerfile) PAIR, not the context alone. Keyed
  // on the directory only, a compose file declaring two services over one
  // context - the common "api" + "worker" split, same source, different
  // Dockerfile - had the second silently dropped: it never reached werf.yaml,
  // never got a Deployment, and nothing said so.
  // Contexts docker-compose already accounted for. The directory scan below
  // must not revisit one: it would re-add the same source a third time under
  // the folder's name, with whichever Dockerfile findDockerfile happens to
  // pick first.
  const composeContexts = new Set();
  // A compose-declared candidate is identified by its compose key, which the
  // file guarantees is unique; a scan-discovered one by its directory. Keyed
  // on the directory for both, a compose file declaring two services over one
  // context - the common "api" + "worker" split, whether they differ by
  // Dockerfile or only by command - had the second silently dropped: it never
  // reached werf.yaml, never got a Deployment, and nothing said so.
  const addCandidate = (dirPath, name, composeName, dockerfile, fromCompose) => {
    const resolved = path.resolve(dirPath);
    if (claimed.has(resolved)) return;
    const key = fromCompose ? 'compose\u0000' + composeName : 'dir\u0000' + resolved;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dirPath: resolved, name, composeName, dockerfile: dockerfile || null });
  };

  // 1. docker-compose is the authoritative inventory of what this repository
  // builds. It is also the ONLY way to find a service that lives nested under
  // services/ or apps/ (a directory scan stops at the top level, and the
  // parent folder holds no Dockerfile of its own to notice), or one built
  // from the repo root.
  let composeBuilds = {};
  try {
    composeBuilds = await findBuildableComposeServices(baseDir);
  } catch (e) { logDebug(e); }

  // How many compose services build from each context. A directory that backs
  // exactly one service can lend it its name; a directory shared by several
  // cannot, or they would all be called the same thing and collide as
  // Kubernetes objects.
  const contextUseCount = {};
  for (const info of Object.values(composeBuilds)) {
    contextUseCount[info.context] = (contextUseCount[info.context] || 0) + 1;
  }
  // Directory basenames are not unique across a monorepo either
  // (services/a/api and services/b/api), so a basename claimed by more than
  // one context cannot name any of them.
  const basenameUseCount = {};
  for (const info of Object.values(composeBuilds)) {
    const base = path.basename(info.context);
    basenameUseCount[base] = (basenameUseCount[base] || 0) + 1;
  }

  for (const [composeName, info] of Object.entries(composeBuilds)) {
    const rel = path.relative(baseDir, info.context);
    const base = path.basename(info.context);
    // A service built from the repo ROOT has no directory of its own to be
    // named after - basename(baseDir) is the repository's name, not the
    // service's - so it keeps its compose key. So does one whose directory
    // backs several services, or whose basename another context also claims:
    // the compose key is the only name guaranteed unique in the file.
    const canUseDirName = rel !== '' && contextUseCount[info.context] === 1 && basenameUseCount[base] === 1;
    const name = canUseDirName ? base : composeName;
    composeContexts.add(path.resolve(info.context));
    addCandidate(info.context, name, composeName, info.dockerfile, true);
  }

  // 2. Directory scan, for services docker-compose doesn't declare (or a
  // project with no compose file at all). One level deep as before, plus the
  // immediate children of a top-level directory that has no Dockerfile
  // itself - the services/, apps/, packages/ monorepo layout.
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SERVICE_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(baseDir, entry.name);

      if (composeContexts.has(path.resolve(fullPath))) continue;
      if (await findDockerfile(fullPath)) {
        addCandidate(fullPath, entry.name, entry.name);
        continue;
      }

      let children = [];
      try {
        children = await fs.readdir(fullPath, { withFileTypes: true });
      } catch (e) { continue; }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('.') || SERVICE_SCAN_IGNORED_DIRS.has(child.name)) continue;
        const childPath = path.join(fullPath, child.name);
        if (composeContexts.has(path.resolve(childPath))) continue;
        if (await findDockerfile(childPath)) addCandidate(childPath, child.name, child.name);
      }
    }
  } catch (e) { logDebug(e); }

  // A service whose context is the repo root would otherwise have every
  // sibling service's source scanned as its own (see the same guard in
  // analyzeFrontend).
  const rootSiblingExcludes = await rootContextExcludes(baseDir, Array.from(claimed));

  for (const candidate of candidates) {
    const isRootContext = path.resolve(candidate.dirPath) === path.resolve(baseDir);
    const composeNames = Array.from(new Set([candidate.composeName, candidate.name].filter(Boolean)));
    try {
      const entry = await buildServiceEntry(
        baseDir,
        candidate.dirPath,
        candidate.name,
        composeNames,
        isRootContext ? rootSiblingExcludes : [],
        candidate.dockerfile,
      );
      if (entry) services.push(entry);
    } catch (e) { logDebug(e); }
  }

  return services;
}

module.exports = { analyzeAdditionalServices, extractUsedEnvVars,  analyzeBackend, analyzeFrontend, detectApiMigrationStep, detectApiWorkerCount, findRoutePortMapFromGatewayConfig, findBuildableComposeServices, rootContextExcludes };
