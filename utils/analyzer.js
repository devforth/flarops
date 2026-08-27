const fs = require('fs').promises;
const path = require('path');

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
        }
      }
    } catch (e) { }
  }
  return Array.from(ports);
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.nuxt', '.output', '.cache']);

async function walkDir(dir, fileList = []) {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.isDirectory()) {
        if (IGNORED_DIRS.has(file.name) || (file.name.startsWith('.') && file.name !== '.env')) {
          continue;
        }
        await walkDir(path.join(dir, file.name), fileList);
      } else {
        const ext = path.extname(file.name);
        // Only scan text-like files and completely ignore lockfiles
        const ignoredFiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
        if (ignoredFiles.has(file.name)) continue;

        if (['.js', '.ts', '.json', '.yaml', '.yml', '.py', '.go', '.sh'].includes(ext) || file.name.startsWith('.env') || file.name.toLowerCase().includes('dockerfile')) {
          fileList.push(path.join(dir, file.name));
        }
      }
    }
  } catch (err) { }
  return fileList;
}

async function findPortsInDir(baseDir, targetDir, portNamesPattern, defaultPort) {
  const regexList = [
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?<!DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)(?:${portNamesPattern})\\s*[:=]\\s*["']?(\\d+)["']?`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?:process\\.env\\.)?(?<!DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)(?:${portNamesPattern})\\s*\\|\\|\\s*(\\d+)`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*(?<!DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)port\\s*[:=]\\s*["']?(\\d+)["']?`, 'gim'),
    new RegExp(`^(?!\\s*(?:#|\\/\\/)).*--inspect(?:-brk)?=(?:[^:]+:)?(\\d+)`, 'gim'),
    new RegExp(`(?:^|\\s)(?:--port|-p)\\s*[=:]?\\s*(\\d+)`, 'gim'),
    new RegExp(`(?<!DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|REDIS_)\\bport\\b.{0,15}?(?<![a-zA-Z0-9.-])(\\d{2,5})\\b`, 'gim'),
    new RegExp(`^\\s*EXPOSE\\s+(\\d+)`, 'gim')
  ];

  let filesToScan = await walkDir(targetDir);

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

async function findDockerfile(dir) {
  try {
    const files = await fs.readdir(dir);
    const exactMatch = files.find(f => f.toLowerCase() === 'dockerfile');
    if (exactMatch) return exactMatch;
    
    const partialMatch = files.find(f => f.toLowerCase().includes('dockerfile'));
    if (partialMatch) return partialMatch;
  } catch(e) {}
  return 'Dockerfile';
}

async function findHealthRoute(backendPath) {
  const possibleRoutes = ['\\/healthz', '\\/health', '\\/ping', '\\/status', '\\/ready', '\\/live'];
  const regex = new RegExp(`['"\`](?:\\/api)?(${possibleRoutes.join('|')})['"\`]`, 'i');

  let filesToScan = await walkDir(backendPath);
  
  for (const filePath of filesToScan) {
    const ext = path.extname(filePath);
    if (!['.js', '.ts', '.go', '.py', '.java', '.cs', '.php'].includes(ext)) continue;
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const match = regex.exec(content);
      if (match && match[1]) {
        return match[1]; // Found a health route
      }
    } catch(e) {}
  }
  
  return null; // Fallback
}

async function analyzeBackend(baseDir) {
  const exactDirs = ['api', 'backend', 'server'];
  const partialDirs = ['api', 'backend', 'server', 'app'];
  let backendPath = null;

  // 1. Try exact match first
  for (const dir of exactDirs) {
    const fullPath = path.join(baseDir, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        backendPath = fullPath;
        break;
      }
    } catch (err) { }
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
          
          if (partialDirs.some(k => lowerName.includes(k))) {
            backendPath = path.join(baseDir, file.name);
            break;
          }
        }
      }
    } catch (err) {}
  }

  if (!backendPath) {
    return { hasBackend: false, backendPath: null, port: 3000, healthRoute: null };
  }

  const portNamesPattern = ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT', 'HTTP_PORT', 'BACKEND_PORT', 'LISTEN_PORT', 'NODE_PORT', 'SERVICE_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, backendPath, portNamesPattern, 3000);
  const composePorts = await findPortsInCompose(baseDir, [...partialDirs, path.basename(backendPath)]);

  const dockerfile = await findDockerfile(backendPath);
  const healthRoute = await findHealthRoute(backendPath);

  if (dirPorts.length === 1 && dirPorts[0] === 3000 && composePorts.length > 0) {
    return { hasBackend: true, backendPath, ports: composePorts, dockerfile, healthRoute };
  }

  const ports = Array.from(new Set([...dirPorts, ...composePorts]));
  return { hasBackend: true, backendPath, ports, dockerfile, healthRoute };
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
      } catch (e) { }
    }
  } catch (e) { }
  return 80;
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
  } catch (e) { }
  
  return null;
}

async function analyzeFrontend(baseDir) {
  const exactDirs = ['frontend', 'client', 'ui', 'web', 'front'];
  let frontendPath = null;

  // 1. Try exact match first
  for (const dir of exactDirs) {
    const fullPath = path.join(baseDir, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        frontendPath = fullPath;
        break;
      }
    } catch (err) { }
  }

  // 2. Fallback to partial match (e.g., 'kanban-ui', 'web-app')
  if (!frontendPath) {
    try {
      const files = await fs.readdir(baseDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
          const lowerName = file.name.toLowerCase();
          if (exactDirs.some(k => lowerName.includes(k))) {
            frontendPath = path.join(baseDir, file.name);
            break;
          }
        }
      }
    } catch (err) {}
  }

  if (!frontendPath) {
    return { hasFrontend: false, frontendPath: null, port: 80 };
  }

  const inferredPort = await inferFrontendPortFromPackage(frontendPath);
  const dockerfilePort = await analyzeDockerfile(frontendPath);
  
  const primaryPort = dockerfilePort !== null ? dockerfilePort : inferredPort;

  const portNamesPattern = ['PORT', 'FRONTEND_PORT', 'VITE_PORT', 'REACT_APP_PORT', 'NUXT_PORT'].join('|');
  const dirPorts = await findPortsInDir(baseDir, frontendPath, portNamesPattern, primaryPort);
  const composePorts = await findPortsInCompose(baseDir, [...exactDirs, path.basename(frontendPath)]);

  const dockerfile = await findDockerfile(frontendPath);

  if (dirPorts.length === 1 && dirPorts[0] === primaryPort && composePorts.length > 0) {
    return { hasFrontend: true, frontendPath, ports: Array.from(new Set([primaryPort, ...composePorts])), dockerfile };
  }

  const ports = Array.from(new Set([primaryPort, ...dirPorts, ...composePorts]));
  return { hasFrontend: true, frontendPath, ports, dockerfile };
}

module.exports = { analyzeBackend, analyzeFrontend };
