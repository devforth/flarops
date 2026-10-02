const fs = require('fs').promises;
const path = require('path');
const { walkDir, logDebug } = require('./fsHelper');
const { COMMON_API_PREFIXES } = require('./constants');

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
      const ignoredRoots = ['/assets', '/static', '/images', '/img', '/public', '/css', '/js', '/fonts', '/_nuxt', '/_next'];
      if (ignoredRoots.includes(root)) return;

      routeScores[root] = (routeScores[root] || 0) + score;
    }
  };

  const httpCallRegex = /(?:fetch|axios|(?:\0)http|client|request|api)(?:\s*\.\s*[a-zA-Z]+)?\s*\(\s*.{0,200}?['"`}]((?:https?:\/\/[^\/\s'"`}]+)?\/[a-zA-Z0-9_\-\/]+)(?:\?|['"`\s])/gims;
  // The host part must not match a newline: [^/] does, whatever the regex flags.
  const envUrlRegex = /^(?:VITE_|REACT_APP_|NEXT_PUBLIC_|NUXT_|VUE_APP_)?[A-Z0-9_]*(?:URL|API|ENDPOINT)\s*=\s*['"`]?((?:https?:\/\/[^\/\s'"`]+)?\/[a-zA-Z0-9_\-\/]+)/gim;

  const proxyRegex = /['"`](\/[a-zA-Z0-9_\-\/]+)['"`]\s*:\s*\{\s*target\s*:/gim;
  const nginxLocationRegex = /location\s+(\/[a-zA-Z0-9_\-\/]+)\/?\s*\{[^}]*proxy_pass/gim;
  
  const craProxyRegex = /"proxy"\s*:\s*"https?:\/\/[^\/\s'"`]+(\/[a-zA-Z0-9_\-\/]+)/gim;

  // RTK Query style: endpoints are returned as paths, not passed to fetch.
  const rtkQueryRegex = /(?:query|queryFn)\s*:\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\(?\s*(?:\{[^}]*?url\s*:\s*)?['"`](\/[a-zA-Z0-9_\-\/]+)/gims;
  const rtkUrlRegex = /\burl\s*:\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;

  const varConcatRegex = /[A-Z0-9_]*(?:URL|API)[A-Z0-9_]*\s*=\s*(?:[a-zA-Z0-9_.]+\s*\+\s*)?['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  
  const baseUrlRegex = /baseURL\s*:\s*[^,'"`}\n]*['"`](\/[a-zA-Z0-9_\-\/]+)['"`]/gim;

  for (const filePath of filesToScan) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const ext = path.extname(filePath);

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
        while ((match = rtkQueryRegex.exec(content)) !== null) {
          addRoute(match[1], 5); // An endpoint declaration names a real path
        }
        while ((match = rtkUrlRegex.exec(content)) !== null) {
          addRoute(match[1], 3);
        }
      }

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

      if (filePath.includes('config') || filePath.includes('setupProxy')) {
        let match;
        while ((match = proxyRegex.exec(content)) !== null) {
          addRoute(match[1], 10); // Proxy configs have very high confidence
        }
      }

      if (filePath.endsWith('.conf')) {
        let match;
        while ((match = nginxLocationRegex.exec(content)) !== null) {
          addRoute(match[1], 10);
        }
      }

      if (path.basename(filePath) === 'package.json') {
        let match;
        while ((match = craProxyRegex.exec(content)) !== null) {
          addRoute(match[1], 10);
        }
      }

    } catch (e) { logDebug(e); }
  }

  const sortedRoutes = Object.entries(routeScores).sort((a, b) => b[1] - a[1]);

  const finalRoutes = [];

  for (const [route, score] of sortedRoutes) {
    if (score >= 5) {
      finalRoutes.push(route);
    }
  }

  const hasHighConfidence = finalRoutes.length > 0;
  for (const [route, score] of sortedRoutes) {
    if (score > 0 && score < 5) {
      if (COMMON_API_PREFIXES.includes(route)) {
        if (!finalRoutes.includes(route)) finalRoutes.push(route);
      }
    }
  }

  return finalRoutes;
}

async function analyzeBackendExposedRoutes(backendDir) {
  if (!backendDir) return [];
  const filesToScan = await walkDir(backendDir);
  const routeScores = {};
  const mountScores = {};

  const addRoute = (route, score) => {
    const root = getRootSegment(route);
    if (root && root !== '/') {
      routeScores[root] = (routeScores[root] || 0) + score;
    }
  };

  // A mount call (app.use, @RequestMapping) states its full prefix; it is not truncated to a root segment.
  const addMountRoute = (route, score) => {
    if (route && route !== '/') {
      mountScores[route] = (mountScores[route] || 0) + score;
    }
  };

  const listenRouteRegex = /(?:app|router|r|server|http|mux)\.(?:get|post|put|delete|patch|all|Group|HandleFunc|Handle)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  const mountRegex = /(?:app|router|server)\.use\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  const pythonRouteRegex = /@(?:app|router|server)\.(?:route|get|post|put|delete|patch)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  const springMethodRouteRegex = /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?\{?\s*['"`](\/[a-zA-Z0-9_\-\/{}]+)/gm;
  const springMountRegex = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?\{?\s*['"`](\/[a-zA-Z0-9_\-\/{}]+)/gm;

  for (const filePath of filesToScan) {
    if (filePath.includes('node_modules') || filePath.includes('.git') || filePath.includes('dist')) continue;
    try {
      const ext = path.extname(filePath);
      if (!['.js', '.ts', '.go', '.py', '.java', '.kt', '.php', '.rb'].includes(ext)) continue;

      const fileContent = await fs.readFile(filePath, 'utf8');

      let match;
      while ((match = listenRouteRegex.exec(fileContent)) !== null) {
        addRoute(match[1], 1);
      }
      while ((match = mountRegex.exec(fileContent)) !== null) {
        addMountRoute(match[1], 1);
      }
      while ((match = pythonRouteRegex.exec(fileContent)) !== null) {
        addRoute(match[1], 1);
      }
      while ((match = springMethodRouteRegex.exec(fileContent)) !== null) {
        addRoute(match[1], 1);
      }
      while ((match = springMountRegex.exec(fileContent)) !== null) {
        addMountRoute(match[1], 1);
      }
    } catch (e) {}
  }

  // Mounts and method routes are merged: one static mount must not hide the API's routes.
  const merged = { ...routeScores };
  for (const [route, score] of Object.entries(mountScores)) {
    merged[route] = (merged[route] || 0) + score + 1;
  }
  return Object.entries(merged).sort((a, b) => b[1] - a[1]).map(r => r[0]);
}

module.exports = { analyzeBackendExposedRoutes, 
  analyzeFrontendRoutes
};
