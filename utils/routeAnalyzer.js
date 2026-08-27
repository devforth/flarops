const fs = require('fs').promises;
const path = require('path');

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
        const ignoredFiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
        if (ignoredFiles.has(file.name)) continue;

        if (['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html', '.conf', '.json'].includes(ext) || file.name.startsWith('.env') || file.name.includes('config')) {
          fileList.push(path.join(dir, file.name));
        }
      }
    }
  } catch (err) { }
  return fileList;
}

function getRootSegment(fullPath) {
  const parts = fullPath.split('?')[0].split('/');
  for (const part of parts) {
    if (part) return '/' + part;
  }
  return null;
}

async function analyzeFrontendRoutes(frontendDir) {
  if (!frontendDir) return [];

  const filesToScan = await walkDir(frontendDir);
  const routeScores = {};

  const addRoute = (route, score) => {
    const root = getRootSegment(route);
    if (root) {
      // Ignore common static asset or frontend roots
      const ignoredRoots = ['/assets', '/static', '/images', '/img', '/public', '/css', '/js', '/fonts', '/_nuxt', '/_next'];
      if (ignoredRoots.includes(root)) return;

      routeScores[root] = (routeScores[root] || 0) + score;
    }
  };

  const httpCallRegex = /(?:fetch|axios(?:\.[a-z]+)?|\$http(?:\.[a-z]+)?|http(?:\.[a-z]+)?|client(?:\.[a-z]+)?|request(?:\.[a-z]+)?|api(?:\.[a-z]+)?)\s*\(\s*.*?['"`}]((?:https?:\/\/[^\/\s'"`}]+)?\/[a-zA-Z0-9_\-\/]+)(?:\?|['"`\s])/gim;
  const envUrlRegex = /^(?:VITE_|REACT_APP_|NEXT_PUBLIC_|NUXT_|VUE_APP_)?[A-Z0-9_]*(?:URL|API|ENDPOINT)\s*=\s*['"`]?((?:https?:\/\/[^\/]+)?\/[a-zA-Z0-9_\-\/]+)/gim;

  // Proxy configs often have '/api': { target: ... } or location /api/ { proxy_pass ... }
  const proxyRegex = /['"`](\/[a-zA-Z0-9_\-\/]+)['"`]\s*:\s*\{\s*target\s*:/gim;
  const nginxLocationRegex = /location\s+(\/[a-zA-Z0-9_\-\/]+)\/?\s*\{[^}]*proxy_pass/gim;
  
  // CRA simple string proxy
  const craProxyRegex = /"proxy"\s*:\s*"https?:\/\/[^\/]+(\/[a-zA-Z0-9_\-\/]+)/gim;

  // Variable assignment with URL concatenation
  const varConcatRegex = /[A-Z0-9_]*(?:URL|API)[A-Z0-9_]*\s*=\s*(?:[a-zA-Z0-9_.]+\s*\+\s*)?['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  
  // Axios/fetch base URL config
  const baseUrlRegex = /baseURL\s*:\s*[^,'"`}\n]*['"`](\/[a-zA-Z0-9_\-\/]+)['"`]/gim;

  for (const filePath of filesToScan) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const ext = path.extname(filePath);

      // 1. Deep source scanning for API calls
      if (['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html'].includes(ext)) {
        let match;
        while ((match = httpCallRegex.exec(content)) !== null) {
          let routePath = match[1];
          if (routePath.startsWith('http')) {
             try {
               const url = new URL(routePath);
               routePath = url.pathname;
             } catch(e) {}
          }
          addRoute(routePath, 1);
        }
        while ((match = varConcatRegex.exec(content)) !== null) {
          addRoute(match[1], 2);
        }
        while ((match = baseUrlRegex.exec(content)) !== null) {
          addRoute(match[1], 5); // Base URL config has high confidence
        }
      }

      // 2. Env vars
      if (path.basename(filePath).startsWith('.env')) {
        let match;
        while ((match = envUrlRegex.exec(content)) !== null) {
          let routePath = match[1];
          if (routePath.startsWith('http')) {
             try {
               const url = new URL(routePath);
               routePath = url.pathname;
             } catch(e) {}
          }
          addRoute(routePath, 5); // Env vars have high confidence
        }
      }

      // 3. Proxy Configs
      if (filePath.includes('config') || filePath.includes('setupProxy')) {
        let match;
        while ((match = proxyRegex.exec(content)) !== null) {
          addRoute(match[1], 10); // Proxy configs have very high confidence
        }
      }

      // 4. Nginx config
      if (filePath.endsWith('.conf')) {
        let match;
        while ((match = nginxLocationRegex.exec(content)) !== null) {
          addRoute(match[1], 10);
        }
      }

      // 5. Package.json
      if (path.basename(filePath) === 'package.json') {
        let match;
        while ((match = craProxyRegex.exec(content)) !== null) {
          addRoute(match[1], 10);
        }
      }

    } catch (e) { }
  }

  // Sort by score
  const sortedRoutes = Object.entries(routeScores).sort((a, b) => b[1] - a[1]);

  const finalRoutes = [];

  // Always include high-confidence routes (score >= 5)
  for (const [route, score] of sortedRoutes) {
    if (score >= 5) {
      finalRoutes.push(route);
    }
  }

  // For low-confidence routes (score < 5), we only add them if we don't have any high confidence ones
  // OR if we suspect they are common API prefixes
  const commonApiPrefixes = ['/api', '/graphql', '/backend', '/v1', '/v2', '/rpc', '/trpc', '/socket.io'];

  const hasHighConfidence = finalRoutes.length > 0;
  for (const [route, score] of sortedRoutes) {
    if (score > 0 && score < 5) {
      if (commonApiPrefixes.includes(route)) {
        if (!finalRoutes.includes(route)) finalRoutes.push(route);
      } else if (!hasHighConfidence) {
        // If absolutely nothing else was found, add it, but this might be risky.
        // If multiple low-score ones exist, we add all of them
        if (!finalRoutes.includes(route)) finalRoutes.push(route);
      }
    }
  }

  return finalRoutes;
}

module.exports = {
  analyzeFrontendRoutes
};
