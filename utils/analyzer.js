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

async function findPortsInCompose(baseDir, possibleServiceNames) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  const ports = new Set();
  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      for (const serviceName of possibleServiceNames) {
        // Match the service block with dynamic indentation
        const serviceRegex = new RegExp('^([ \\t]+)' + serviceName + ':\\s*$([\\s\\S]*?)(?=^\\1[a-zA-Z0-9_-]+:\\s*$|^\\S|(?![\\s\\S]))', 'gm');
        let match;
        while ((match = serviceRegex.exec(content)) !== null) {
          const serviceBlock = match[2];
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
      for (const regex of regexList) {
        const matches = [...content.matchAll(regex)];
        for (const match of matches) {
          if (match[1]) {
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

async function findHealthRoute(backendPath, excludeDirNames = []) {
  const possibleRoutes = ['\\/healthz', '\\/health-check', '\\/healthcheck', '\\/health', '\\/ping', '\\/status', '\\/ready', '\\/live'];
  // Allow an optional trailing slash before the closing quote - frameworks
  // like FastAPI commonly declare routes as e.g. "/health-check/".
  const regex = new RegExp(`['"\`](?:\\/api)?(${possibleRoutes.join('|')})\\/?['"\`]`, 'i');

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
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const match = regex.exec(content);
      if (match && match[1]) {
        return match[1]; // Found a health route
      }
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
  const healthRoute = await findHealthRoute(backendPath, scanExcludeDirNames);
  const needsRootContext = dockerfile ? await dockerfileNeedsRootContext(baseDir, backendPath, dockerfile) : false;

  if (dirPorts.length === 1 && dirPorts[0] === 3000 && composePorts.length > 0) {
    return { hasBackend: true, backendPath, ports: composePorts, dockerfile, healthRoute, needsRootContext };
  }

  const ports = Array.from(new Set([...dirPorts, ...composePorts]));
  return { hasBackend: true, backendPath, ports, dockerfile, healthRoute, needsRootContext };
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
  const dirPorts = (await findPortsInDir(baseDir, frontendPath, portNamesPattern, primaryPort)).filter(p => p !== null);
  const composePorts = await findPortsInCompose(baseDir, [...exactDirs, path.basename(frontendPath)]);

  const dockerfile = await findDockerfile(frontendPath);
  const needsRootContext = dockerfile ? await dockerfileNeedsRootContext(baseDir, frontendPath, dockerfile) : false;

  if (primaryPort !== null && dirPorts.length === 1 && dirPorts[0] === primaryPort && composePorts.length > 0) {
    return { hasFrontend: true, frontendPath, ports: Array.from(new Set([primaryPort, ...composePorts])), dockerfile, needsRootContext };
  }

  const knownPorts = [primaryPort, ...dirPorts, ...composePorts].filter(p => p !== null);
  const ports = knownPorts.length > 0 ? Array.from(new Set(knownPorts)) : [80];
  return { hasFrontend: true, frontendPath, ports, dockerfile, needsRootContext };
}


async function extractUsedEnvVars(serviceDir) {
  const { walkDir, logDebug } = require('./fsHelper');
  const envVars = new Set();
  
  if (!serviceDir) return Array.from(envVars);

  try {
    const files = await walkDir(serviceDir);
    const envVarRegex = /(?:process\.env\.|process\.env\[['"`]|os\.Getenv\(['"`]|getenv\(['"`]|System\.getenv\(['"`]|Environment\.GetEnvironmentVariable\(['"`]\$?|\$ENV\[['"`]|\$_ENV\[['"`]|\$\b)([a-zA-Z_][a-zA-Z0-9_]+)/g;
    const destructureRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;

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

async function analyzeAdditionalServices(baseDir, knownPaths) {
  const { walkDir, logDebug } = require('./fsHelper');
  const services = [];
  try {
    const files = await fs.readdir(baseDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isDirectory() || file.name.startsWith('.') || SERVICE_SCAN_IGNORED_DIRS.has(file.name)) continue;
      
      const fullPath = require('path').join(baseDir, file.name);
      if (knownPaths.includes(fullPath)) continue;
      
      const dockerfile = await findDockerfile(fullPath);
      if (!dockerfile) continue;
      
      // It has a Dockerfile, so it's a service
      // Let's find its port, healthRoute, usedEnvVars, and exposed HTTP routes
      const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'SERVICE_PORT'].join('|');
      const dirPorts = await findPortsInDir(baseDir, fullPath, portNamesPattern, null);
      const composePorts = await findPortsInCompose(baseDir, [file.name]);
      
      let ports = Array.from(new Set([...dirPorts, ...composePorts])).filter(p => p !== null);
      if (ports.length === 0) ports = [80]; // fallback
      
      const healthRoute = await findHealthRoute(fullPath);
      const usedEnvVars = await extractUsedEnvVars(fullPath);

      // Try to find if it exposes any HTTP routes that should be public
      const { analyzeBackendExposedRoutes } = require('./routeAnalyzer');
      const apiRoutes = await analyzeBackendExposedRoutes(fullPath);
      // Reusing routeAnalyzer since it looks for fetch/axios/proxies, but actually we need to find what it *listens* on.
      // Wait, routeAnalyzer finds what it calls, not what it listens on!

      const isReactorModule = await isMavenReactorModule(baseDir, fullPath);

      services.push({
        name: file.name,
        path: fullPath,
        ports,
        healthRoute,
        usedEnvVars,
        dockerfile,
        exposedRoutes: apiRoutes,
        isMavenReactorModule: isReactorModule
      });
    }
  } catch(e) {}
  return services;
}

module.exports = { analyzeAdditionalServices, extractUsedEnvVars,  analyzeBackend, analyzeFrontend, detectApiMigrationStep, detectApiWorkerCount, findRoutePortMapFromGatewayConfig };
