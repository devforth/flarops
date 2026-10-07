const fs = require('./textFs.js');
const path = require('path');
const { listComposeFiles, composeBaseDir } = require('./composeFiles');
const { walkDir, logDebug } = require('./fsHelper');
const { SERVICE_SCAN_IGNORED_DIRS } = require('./constants');

// Conventional "run before the app starts" scripts: migrations and seed data.
const PRESTART_SCRIPT_CANDIDATES = ['scripts/prestart.sh', 'scripts/migrate.sh', 'prestart.sh', 'migrate.sh'];

// Worker processes the backend's Dockerfile spawns; each is a full copy, so memory scales with them.
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

// Returns { checkFile, command }; checkFile gates the command at runtime, so a wrong guess is a no-op.
async function detectApiMigrationStep(backendPath) {
  if (!backendPath) return null;
  for (const candidate of PRESTART_SCRIPT_CANDIDATES) {
    try {
      await fs.access(path.join(backendPath, candidate));
      return { checkFile: candidate, command: `bash ${candidate}` };
    } catch (e) { /* try next candidate */ }
  }
  // Django: manage.py at the root means `manage.py migrate`.
  try {
    await fs.access(path.join(backendPath, 'manage.py'));
    return { checkFile: 'manage.py', command: 'python manage.py migrate' };
  } catch (e) { /* not a Django project */ }
  return null;
}

// Top-level service blocks of a compose file, keyed by name, anchored to the file's own indentation.
function splitComposeServiceBlocks(content) {
  const blocks = {};
  const servicesMatch = content.match(/^services:\s*$/m);
  if (!servicesMatch) return blocks;
  // Only the services: section - entries under networks: or volumes: are not services.
  const afterServices = (content.slice(servicesMatch.index + servicesMatch[0].length) + '\n').split(/\n(?=[^\s#])/)[0];

  const firstServiceMatch = afterServices.match(/^([ \t]+)([a-zA-Z0-9_.-]+):\s*$/m);
  if (!firstServiceMatch) return blocks;
  const indent = firstServiceMatch[1];

  const blockRegex = new RegExp('^' + indent + '([a-zA-Z0-9_.-]+):\\s*$([\\s\\S]*?)(?=^' + indent + '[a-zA-Z0-9_.-]+:\\s*$|^\\S|(?![\\s\\S]))', 'gm');
  let m;
  while ((m = blockRegex.exec(afterServices)) !== null) blocks[m[1]] = m[2];
  return blocks;
}

// A service's "ports:" entries in either style (block list or flow), unquoted.
function composePortEntries(serviceBlock) {
  const lines = String(serviceBlock).split('\n');
  const out = [];
  let indent = null;
  for (const line of lines) {
    if (indent === null) {
      const m = line.match(/^([ \t]*)ports:\s*(.*)$/);
      if (!m) continue;
      indent = m[1].length;
      const inline = m[2].replace(/\s+#.*$/, '').trim();
      if (inline.startsWith('[')) {
        for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
          const value = part.trim().replace(/^["']|["']$/g, '');
          if (value) out.push(value);
        }
        break;
      }
      if (inline !== '') break; // something else entirely on the same line
      continue;
    }
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (line.match(/^([ \t]*)/)[1].length <= indent) break;
    const item = line.trim().replace(/^-\s*/, '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    if (item) out.push(item);
  }
  return out;
}

async function findPortsInCompose(baseDir, possibleServiceNames) {
  const composeFiles = listComposeFiles(baseDir);
  const ports = new Set();
  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      const serviceBlocks = splitComposeServiceBlocks(content);
      for (const serviceName of possibleServiceNames) {
        const serviceBlock = serviceBlocks[serviceName];
        if (serviceBlock !== undefined) {
          for (const entry of composePortEntries(serviceBlock)) {
            // "8080:80" is container port 80; an IP prefix binds the host side.
            const m = entry.match(/^(?:\d+\.\d+\.\d+\.\d+:)?(?:\d+:)?(\d+)(?:\/[a-z]+)?$/i);
            if (m) ports.add(parseInt(m[1], 10));
          }

          // Behind a reverse proxy the port may appear only as a Traefik loadbalancer label.
          const traefikPortRegex = /loadbalancer\.server\.port=(\d+)/gi;
          let traefikMatch;
          while ((traefikMatch = traefikPortRegex.exec(serviceBlock)) !== null) {
            ports.add(parseInt(traefikMatch[1], 10));
          }

          // Or only in a healthcheck URL.
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

async function findServiceContextFromCompose(baseDir, serviceNames) {
  const composeFiles = listComposeFiles(baseDir);
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

      const contextPath = path.resolve(composeBaseDir(baseDir, file), contextMatch[1]);
      try {
        const stat = await fs.stat(contextPath);
        if (stat.isDirectory()) return contextPath;
      } catch (e) { /* referenced context doesn't exist on disk */ }
    }
  }
  return null;
}

// Every compose service that builds from a context: name -> { context, dockerfile }.
async function findBuildableComposeServices(baseDir) {
  const composeFiles = listComposeFiles(baseDir);
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }

    const blocks = splitComposeServiceBlocks(content);
    const out = {};
    for (const [name, block] of Object.entries(blocks)) {
      const ctxMatch = block.match(/^\s*context:\s*["']?([^\s"'#]+)["']?/m);
      const shortMatch = block.match(/^\s*build:\s*["']?([^\s"'#][^\s"'#]*)["']?\s*$/m);
      const rawContext = ctxMatch ? ctxMatch[1] : (shortMatch ? shortMatch[1] : null);
      if (!rawContext) continue;

      const dfMatch = block.match(/^\s*dockerfile:\s*["']?([^\s"'#]+)["']?/m);
      out[name] = {
        // Contexts resolve against the compose file's own directory, as compose does.
        context: path.resolve(composeBaseDir(baseDir, file), rawContext),
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

// A "port:" key may belong to a client this service talks to; only listen-port key paths count.
const CLIENT_COMPONENT_KEY_REGEX = /^(redis|valkey|mongo|mongodb|datasource|jdbc|r2dbc|elasticsearch|opensearch|solr|rabbitmq|amqp|kafka|pulsar|nats|mail|smtp|imap|ftp|sftp|ldap|memcached|cassandra|influx|neo4j|etcd|consul|vault|minio|s3|eureka|zipkin|jaeger|otlp|statsd|graphite|sentry|keycloak|oauth2|clickhouse|db|database|cache|broker|queue|registry|discovery|client|proxy|upstream|remote|external)$/i;

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

    const parts = [...stack.map(e => e.key), ...key.split('.')];
    if (parts[parts.length - 1].toLowerCase() === 'port') {
      const num = value.match(/^["']?(\d+)["']?$/);
      if (num && isListenPortPath(parts)) found.add(parseInt(num[1], 10));
    }
    if (value === '') stack.push({ indent, key });
  }
  return found;
}

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

// Documentation describes ports, it does not configure them.
const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt'];

// A port next to another component's name is that component's port.
const CLIENT_PORT_CONTEXT_REGEX = /\b(dd|datadog|trace|apm|agent|statsd|otlp|jaeger|zipkin|redis|valkey|mongo|mongodb|mysql|postgres|postgresql|pg|mariadb|rabbit|rabbitmq|amqp|kafka|pulsar|nats|memcached?|elastic|elasticsearch|opensearch|solr|smtp|mail|imap|ldap|consul|vault|etcd|eureka|zookeeper|influx|influxdb|clickhouse|cassandra|neo4j|minio|sentry|grafana|prometheus|loki|tempo|db|database)[_-]/i;

// Ports in tests belong to what the test starts, not to the service.
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
    // Comment lines are skipped: prose like "port 8080" is not configuration.
    new RegExp(`^(?!\\s*(?:#|\\/\\/))(?:.*?)(?:^|\\s)(?:--port|-p)\\s*[=:]?\\s*(\\d+)`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?<!PG_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)\\bport\\b.{0,15}?(?<![a-zA-Z0-9.-])(\\d{2,5})\\b`, 'gim'),
    new RegExp(`^\\s*EXPOSE\\s+(\\d+)`, 'gim')
  ];

  let filesToScan = await walkDir(targetDir);

  // When the service is the repo root, sibling services' source is excluded from the scan.
  if (excludeDirNames.length > 0) {
    filesToScan = filesToScan.filter(f => {
      const rel = path.relative(targetDir, f);
      const firstSegment = rel.split(path.sep)[0];
      return !excludeDirNames.includes(firstSegment);
    });
  }

  filesToScan = filesToScan.filter(f => !isTestPath(path.relative(targetDir, f)));

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
            const lineStart = content.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
            let contextStart = lineStart;
            for (let back = 0; back < 2 && contextStart > 0; back++) {
              contextStart = content.lastIndexOf('\n', contextStart - 2) + 1;
            }
            const contextText = content.slice(contextStart, match.index + match[0].length);
            if (CLIENT_PORT_CONTEXT_REGEX.test(contextText)) continue;
            const portNum = parseInt(match[1], 10);
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

// Dockerfiles for tests or CI, never for production.
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

// A compose healthcheck is the most reliable statement of the health endpoint.
function findHealthCheckInComposeBlock(serviceBlock) {
  if (!serviceBlock) return null;
  const healthcheckIdx = serviceBlock.search(/^\s*healthcheck:/m);
  if (healthcheckIdx === -1) return null;
  const section = serviceBlock.slice(healthcheckIdx);
  const urlMatch = section.match(/https?:\/\/[^\s"'\\]*?(?::(\d+))?(\/[^\s"'\\|)]*)/i);
  if (!urlMatch) return null;
  const route = urlMatch[2];
  if (!route || route === '/') return { route: '/', port: urlMatch[1] ? parseInt(urlMatch[1], 10) : null };
  return { route: route.replace(/[?#].*$/, ''), port: urlMatch[1] ? parseInt(urlMatch[1], 10) : null };
}

// The compose service that BUILDS from `dir` (not one named after it) - its ports and healthcheck
// describe what runs from there. Several share a directory: the conventionally named one wins,
// then the only one publishing ports; otherwise none.
async function composeServicesBuiltFrom(baseDir, dir, conventionalNames = []) {
  let builds;
  try { builds = await findBuildableComposeServices(baseDir); } catch (e) { return []; }
  const built = Object.entries(builds)
    .filter(([, info]) => path.resolve(info.context) === path.resolve(dir))
    .map(([name]) => name);
  if (built.length <= 1) return built;

  const named = built.filter(name => conventionalNames.includes(name));
  if (named.length > 0) return named;

  const blocks = {};
  for (const file of listComposeFiles(baseDir)) {
    try {
      Object.assign(blocks, splitComposeServiceBlocks(await fs.readFile(path.join(baseDir, file), 'utf8')));
      break;
    } catch (e) { /* not this one */ }
  }
  const publishing = built.filter(name => blocks[name] && composePortEntries(blocks[name]).length > 0);
  return publishing.length === 1 ? publishing : [];
}

async function findHealthCheckFromCompose(baseDir, serviceNames) {
  const composeFiles = listComposeFiles(baseDir);
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

// Frameworks with a fixed health endpoint once the dependency is present.
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

// A health route is relative to the class/router prefix it is mounted under.
function findMountPrefixForHealth(content, ext) {
  if (ext === '.java') {
    const m = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)[\s\S]{0,400}?\bclass\s+\w/);
    if (m) return m[1];
    return null;
  }
  if (ext === '.ts' || ext === '.js') {
    const nest = content.match(/@Controller\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (nest) return nest[1].startsWith('/') ? nest[1] : '/' + nest[1];
    return null;
  }
  if (ext === '.py') {
    const m = content.match(/url_prefix\s*=\s*["']([^"']+)["']/) ||
      content.match(/APIRouter\s*\([^)]*prefix\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
    return null;
  }
  return null;
}

async function findHealthRoute(backendPath, excludeDirNames = []) {
  const possibleRoutes = ['\\/healthz', '\\/health-check', '\\/healthcheck', '\\/health', '\\/ping', '\\/status', '\\/ready', '\\/live'];
  // Capture the whole literal: "/api/health" stays "/api/health".
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

// Infrastructure components whose names contain "server"/"app" but are not the backend.
const NON_BUSINESS_BACKEND_DIRS = ['config-server', 'config server', 'configserver', 'eureka-server', 'eureka server', 'discovery-server', 'discovery server', 'service-registry', 'registry-server', 'naming-server', 'zookeeper', 'consul-server'];

async function analyzeBackend(baseDir) {
  const exactDirs = ['api', 'backend', 'server'];
  const partialDirs = ['api', 'backend', 'server', 'app'];
  let backendPath = null;

  // A compose service named api/backend/server is ground truth for the backend's directory.
  const composeContext = await findServiceContextFromCompose(baseDir, exactDirs);
  if (composeContext && await findDockerfile(composeContext)) {
    backendPath = composeContext;
  }

  // Only a candidate with its own Dockerfile.
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

  if (!backendPath) {
    try {
      const files = await fs.readdir(baseDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
          const lowerName = file.name.toLowerCase();
          if (['ui', 'frontend', 'client', 'web', 'front'].some(k => lowerName.includes(k))) continue;
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

  // Last resort: a Dockerfile at the repo root, unless it serves a static frontend.
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

  const scanExcludeDirNames = backendPath === baseDir ? ['frontend', 'client', 'ui', 'web', 'front'] : [];

  const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'BACKEND_PORT', 'LISTEN_PORT', 'NODE_PORT', 'SERVICE_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, backendPath, portNamesPattern, 3000, scanExcludeDirNames);
  const builtFromBackend = await composeServicesBuiltFrom(baseDir, backendPath, [...partialDirs, path.basename(backendPath)]);
  const composePorts = await findPortsInCompose(baseDir, [...builtFromBackend, ...partialDirs, path.basename(backendPath)]);

  // The compose-declared Dockerfile wins over findDockerfile's guess.
  let composeDockerfile = null;
  if (builtFromBackend.length > 0) {
    try {
      const builds = await findBuildableComposeServices(baseDir);
      composeDockerfile = (builds[builtFromBackend[0]] || {}).dockerfile || null;
    } catch (e) { logDebug(e); }
  }
  const dockerfile = composeDockerfile || await findDockerfile(backendPath);
  // Most authoritative first: the compose probe, a framework convention, then a route in source.
  const composeHealth = await findHealthCheckFromCompose(baseDir, [...builtFromBackend, path.basename(backendPath), ...partialDirs]);
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

  // A compose service named frontend/client/ui/web: its context is the frontend, wherever it points.
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

  // 80 only as a last resort: a fixed fallback must not masquerade as a found port.
  const primaryPort = dockerfilePort !== null ? dockerfilePort : inferredPort;

  const portNamesPattern = ['PORT', 'FRONTEND_PORT', 'VITE_PORT', 'REACT_APP_PORT', 'NUXT_PORT'].join('|');
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
  const builtFromFrontend = await composeServicesBuiltFrom(baseDir, frontendPath, [...exactDirs, path.basename(frontendPath)]);
  const composePorts = await findPortsInCompose(baseDir, [...builtFromFrontend, ...exactDirs, path.basename(frontendPath)]);

  const dockerfile = composeDockerfile || await findDockerfile(frontendPath);
  const needsRootContext = dockerfile ? await dockerfileNeedsRootContext(baseDir, frontendPath, dockerfile) : false;

  if (primaryPort !== null && dirPorts.length === 1 && dirPorts[0] === primaryPort && composePorts.length > 0) {
    return { hasFrontend: true, frontendPath, ports: Array.from(new Set([primaryPort, ...composePorts])), dockerfile, needsRootContext };
  }

  const knownPorts = [primaryPort, ...dirPorts, ...composePorts].filter(p => p !== null);
  const ports = knownPorts.length > 0 ? Array.from(new Set(knownPorts)) : [80];
  return { hasFrontend: true, frontendPath, ports, dockerfile, needsRootContext };
}

// When the service is the repo root, exclude sibling services' directories.
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

    // Python os.environ and Ruby ENV.
    const pythonRubyEnvRegex = /(?:os\.environ(?:\.get)?\s*[[(]\s*['"]|\bENV\s*(?:\.fetch\s*\(\s*)?\[?\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g;
    // Go struct tags (env:"X"): there is no Getenv call to find.
    const goStructTagRegex = /\b(?:env|envconfig)\s*:\s*"([A-Z_][A-Z0-9_]*)"/g;

    for (const file of files) {
      if (file.includes('node_modules') || file.includes('.git') || file.includes('dist') || file.includes('build')) continue;
      try {
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

        // Spring reads ${VAR} placeholders from config files.
        const base = path.basename(file);
        if (/^application(-[\w.]+)?\.(ya?ml|properties)$/.test(base) || /^bootstrap(-[\w.]+)?\.(ya?ml|properties)$/.test(base)) {
          const springPlaceholderRegex = /\$\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?::[^}]*)?\}/g;
          let springMatch;
          while ((springMatch = springPlaceholderRegex.exec(fileContent)) !== null) {
            // Only the SCREAMING_SNAKE form can be set as a container env var.
            const name = springMatch[1];
            if (/^[A-Z][A-Z0-9_]*$/.test(name)) envVars.add(name);
          }
        }

        // pydantic BaseSettings fields are env vars without any os.getenv call.
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

// True if the Dockerfile COPYs something that exists only relative to the repo root, so the root
// must be the build context.
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

// Never treat Flarops' own dashboard copy as one of the project's services.
async function isFlaropsOwnDashboard(servicePath) {
  try {
    const goMod = await fs.readFile(path.join(servicePath, 'go.mod'), 'utf8');
    return /module\s+github\.com\/devforth\/flarops/.test(goMod);
  } catch (e) {
    return false;
  }
}

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

/**
 * One entry of the additionalServices[] list. DISCOVERY fields come from this file; DEPLOYMENT
 * fields are filled in later by bin/commands/init.js, but every field has its final type from
 * the start (see makeServiceEntry).
 *
 * @typedef {Object} ServiceEntry
 *
 * -- discovery (analyzeAdditionalServices) --
 * @property {string}   name         k8s object name; init.js sanitizes this to RFC 1123 and de-duplicates it.
 * @property {string}   originalName the name before that sanitization, so compose keys still match.
 * @property {string}   composeName  the docker-compose key, which every env/depends_on lookup keys off.
 * @property {string}   path         absolute build context.
 * @property {string}   dockerfile   Dockerfile path relative to the context.
 * @property {number[]} ports        ports the service listens on; [80] when nothing was found.
 * @property {?string}  healthRoute  HTTP path for the probes, or null.
 * @property {?number}  healthPort   port for the probes when compose named one.
 * @property {string[]} usedEnvVars  env var names the source actually reads.
 * @property {boolean}  isMavenReactorModule  changes how werf.yaml addresses the context.
 *
 * -- deployment (bin/commands/init.js) --
 * @property {string}            relativePath   context relative to the repo root, for werf.yaml.
 * @property {number}            replicas       pod count; 1 unless flarops.yaml says otherwise.
 * @property {boolean}           oneShot        a task that runs to completion; rendered as a Job, not a Deployment.
 * @property {Object}            env            plain config, rendered into values.yaml in the clear.
 * @property {string[]}          secretKeys     Secret keys mounted under their own names.
 * @property {Set<string>}       forcedSecretKeys keys wired during the compose
 *   scan. secretKeys is fully REASSIGNED later from a usedEnvVars filter that
 *   can only be computed once the whole scan has finished, so anything pushed
 *   onto it during the scan would be silently discarded at that moment; these
 *   are collected separately and merged back in afterwards.
 * @property {Array<{envName: string, secretKey: string}>} extraSecretEnvMappings  container-side name differs from the Secret key.
 * @property {string[]}          exposedRoutes  HTTP prefixes this service owns on the Ingress.
 * @property {boolean}           suppressDirectIngress  true when a gateway fronts it, so it gets no Ingress of its own.
 * @property {?Object}           db             the database this service talks to, or null.
 * @property {?string}           dbPasswordKey  Secret key holding that database's password.
 * @property {Array<{key: string, dbName: ?string, query: ?string}>} dbUrlVars  env vars to be rebuilt as full DB URLs.
 * @property {?string}           springDatasourcePasswordSecretKey  Spring reads its password under a fixed name.
 * @property {?Object}           buildArgs      docker build args; null, never {}, so werf.yaml emits no empty args block.
 * @property {?string[]}         command        compose `command:` override, carried to the pod as args.
 */

function makeServiceEntry(discovered) {
  return {
    ...discovered,
    replicas: 1,
    oneShot: false,
    env: {},
    secretKeys: [],
    forcedSecretKeys: new Set(),
    extraSecretEnvMappings: [],
    exposedRoutes: discovered.exposedRoutes || [],
    suppressDirectIngress: false,
    db: null,
    dbPasswordKey: null,
    dbUrlVars: [],
    springDatasourcePasswordSecretKey: null,
    buildArgs: null,
    command: null,
  };
}

async function buildServiceEntry(baseDir, dirPath, name, composeNames, siblingExcludes, composeDockerfile, { sharesDirectory = false } = {}) {
  const dockerfile = composeDockerfile || await findDockerfile(dirPath);
  if (!dockerfile) return null;
  if (await isFlaropsOwnDashboard(dirPath)) return null;

  const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'SERVICE_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, dirPath, portNamesPattern, null, siblingExcludes || []);
  const composePorts = await findPortsInCompose(baseDir, composeNames);

  // A directory shared with another service holds THAT service's ports and routes too, so only what
  // compose states about this one counts; with no port it gets no Service and no probes.
  let ports = Array.from(new Set([...(sharesDirectory ? [] : dirPorts), ...composePorts])).filter(p => p !== null);
  if (ports.length === 0 && !sharesDirectory) ports = [80]; // fallback

  const composeHealth = await findHealthCheckFromCompose(baseDir, composeNames);
  const healthRoute = (composeHealth && composeHealth.route)
    || (sharesDirectory ? null : (await findFrameworkHealthRoute(dirPath) || await findHealthRoute(dirPath)));
  const healthPort = composeHealth ? composeHealth.port : null;
  // Same for env vars: compose's environment:/env_file are the whole truth for a compose service.
  const usedEnvVars = sharesDirectory ? [] : await extractUsedEnvVars(dirPath, siblingExcludes || []);

  const { analyzeBackendExposedRoutes } = require('./routeAnalyzer');
  // No port, no Service - and no Ingress route to it.
  const exposedRoutes = ports.length > 0 ? await analyzeBackendExposedRoutes(dirPath) : [];
  const isReactorModule = await isMavenReactorModule(baseDir, dirPath);

  return makeServiceEntry({
    name,
    relativePath: path.relative(baseDir, dirPath),
    // The compose key may differ from the sanitized name; keep the original for matching.
    originalName: name,
    composeName: composeNames.find(n => n !== name) || name,
    path: dirPath,
    ports,
    healthRoute,
    healthPort,
    usedEnvVars,
    dockerfile,
    exposedRoutes,
    isMavenReactorModule: isReactorModule,
  });
}

async function analyzeAdditionalServices(baseDir, knownPaths, claimedComposeNames = new Set()) {
  const services = [];
  const claimed = new Set((knownPaths || []).filter(Boolean).map(p => path.resolve(p)));
  const seen = new Set();
  const candidates = [];

  const composeContexts = new Set();
  // A compose candidate is identified by its compose key, a scanned one by its directory: several
  // compose services may share one context.
  const addCandidate = (dirPath, name, composeName, dockerfile, fromCompose) => {
    const resolved = path.resolve(dirPath);
    // A claimed context can still back other compose services; only the claimed key is a duplicate.
    if (claimed.has(resolved) && !fromCompose) return;
    if (claimed.has(resolved) && fromCompose && claimedComposeNames.has(composeName)) return;
    const key = fromCompose ? 'compose\u0000' + composeName : 'dir\u0000' + resolved;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ dirPath: resolved, name, composeName, dockerfile: dockerfile || null });
  };

  // 1. docker-compose is the authoritative inventory of what the repository builds.
  let composeBuilds = {};
  try {
    composeBuilds = await findBuildableComposeServices(baseDir);
  } catch (e) { logDebug(e); }

  // A directory backing several services cannot lend them its name.
  const contextUseCount = {};
  for (const info of Object.values(composeBuilds)) {
    contextUseCount[info.context] = (contextUseCount[info.context] || 0) + 1;
  }
  const basenameUseCount = {};
  for (const info of Object.values(composeBuilds)) {
    const base = path.basename(info.context);
    basenameUseCount[base] = (basenameUseCount[base] || 0) + 1;
  }

  for (const [composeName, info] of Object.entries(composeBuilds)) {
    const rel = path.relative(baseDir, info.context);
    const base = path.basename(info.context);
    // Root-context and shared-context services keep their compose key as a name.
    const canUseDirName = rel !== '' && contextUseCount[info.context] === 1 && basenameUseCount[base] === 1;
    const name = canUseDirName ? base : composeName;
    composeContexts.add(path.resolve(info.context));
    // A compose-declared Dockerfile's directory is accounted for, so the scan does not find it again.
    if (info.dockerfile && path.dirname(info.dockerfile) !== '.') {
      composeContexts.add(path.resolve(info.context, path.dirname(info.dockerfile)));
    }
    addCandidate(info.context, name, composeName, info.dockerfile, true);
  }

  // 2. Directory scan for services compose does not declare: one level, plus children of a
  // Dockerfile-less top-level directory (services/, apps/).
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

  const rootSiblingExcludes = await rootContextExcludes(baseDir, Array.from(claimed));

  for (const candidate of candidates) {
    const isRootContext = path.resolve(candidate.dirPath) === path.resolve(baseDir);
    const composeNames = Array.from(new Set([candidate.composeName, candidate.name].filter(Boolean)));
    // Another service builds from the same directory.
    const sharesDirectory = claimed.has(candidate.dirPath) || (contextUseCount[candidate.dirPath] || 0) > 1;
    try {
      const entry = await buildServiceEntry(
        baseDir,
        candidate.dirPath,
        candidate.name,
        composeNames,
        isRootContext ? rootSiblingExcludes : [],
        candidate.dockerfile,
        { sharesDirectory },
      );
      if (entry) services.push(entry);
    } catch (e) { logDebug(e); }
  }

  return services;
}

module.exports = { analyzeAdditionalServices, makeServiceEntry, extractUsedEnvVars,  analyzeBackend, analyzeFrontend, detectApiMigrationStep, detectApiWorkerCount, findRoutePortMapFromGatewayConfig, findBuildableComposeServices, rootContextExcludes };
