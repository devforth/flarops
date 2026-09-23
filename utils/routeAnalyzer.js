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
      // Ignore common static asset or frontend roots
      const ignoredRoots = ['/assets', '/static', '/images', '/img', '/public', '/css', '/js', '/fonts', '/_nuxt', '/_next'];
      if (ignoredRoots.includes(root)) return;

      routeScores[root] = (routeScores[root] || 0) + score;
    }
  };

  const httpCallRegex = /(?:fetch|axios|(?:\0)http|client|request|api)(?:\s*\.\s*[a-zA-Z]+)?\s*\(\s*.{0,200}?['"`}]((?:https?:\/\/[^\/\s'"`}]+)?\/[a-zA-Z0-9_\-\/]+)(?:\?|['"`\s])/gims;
  const envUrlRegex = /^(?:VITE_|REACT_APP_|NEXT_PUBLIC_|NUXT_|VUE_APP_)?[A-Z0-9_]*(?:URL|API|ENDPOINT)\s*=\s*['"`]?((?:https?:\/\/[^\/]+)?\/[a-zA-Z0-9_\-\/]+)/gim;

  // Proxy configs often have '/api': { target: ... } or location /api/ { proxy_pass ... }
  const proxyRegex = /['"`](\/[a-zA-Z0-9_\-\/]+)['"`]\s*:\s*\{\s*target\s*:/gim;
  const nginxLocationRegex = /location\s+(\/[a-zA-Z0-9_\-\/]+)\/?\s*\{[^}]*proxy_pass/gim;
  
  // CRA simple string proxy
  const craProxyRegex = /"proxy"\s*:\s*"https?:\/\/[^\/]+(\/[a-zA-Z0-9_\-\/]+)/gim;

  // RTK Query and the same shape in other data layers. Endpoints are declared
  // as a "query"/"queryFn"/"url" that RETURNS the path rather than calling
  // fetch with it, so none of the call-site patterns above ever see it - a
  // createApi frontend looked like it talked to nothing at all. Covers both
  // the arrow-returning-template form, "query: (id) => `/students/${id}`",
  // and the object form, "query: () => ({ url: '/courses' })".
  const rtkQueryRegex = /(?:query|queryFn)\s*:\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\(?\s*(?:\{[^}]*?url\s*:\s*)?['"`](\/[a-zA-Z0-9_\-\/]+)/gims;
  const rtkUrlRegex = /\burl\s*:\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;

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
        while ((match = rtkQueryRegex.exec(content)) !== null) {
          addRoute(match[1], 5); // An endpoint declaration names a real path
        }
        while ((match = rtkUrlRegex.exec(content)) !== null) {
          addRoute(match[1], 3);
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

    } catch (e) { logDebug(e); }
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
  const hasHighConfidence = finalRoutes.length > 0;
  for (const [route, score] of sortedRoutes) {
    if (score > 0 && score < 5) {
      if (COMMON_API_PREFIXES.includes(route)) {
        if (!finalRoutes.includes(route)) finalRoutes.push(route);
      }
      // Removed the risky fallback that included all low-confidence routes
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

  // A mount call (app.use('/api/interactions', router), Spring's class-level
  // @RequestMapping) states its FULL prefix directly - unlike a method-level
  // route handler, there's no missing information to fall back to a root
  // segment for. Truncating it the same way addRoute does for method-level
  // routes throws away the one thing that distinguishes it from another,
  // unrelated service mounted under the same generic first segment (e.g.
  // "/api/interactions" and "/api/users" both collapsing to "/api") - which
  // then falsely looks like two services claiming the identical Ingress path,
  // and the conflict resolution in init.js drops the "conflict" from both,
  // leaving neither with a working route at all. Tracked separately from
  // routeScores: once we know the real mount prefix, the method-level routes
  // found inside whatever gets mounted there (e.g. router.get('/read', ...)
  // inside the router mounted at /api/interactions) are almost certainly
  // nested under it, not siblings of it - a plain "/read" Ingress rule would
  // be actively wrong (the app only ever sees /api/interactions/read).
  const addMountRoute = (route, score) => {
    if (route && route !== '/') {
      mountScores[route] = (mountScores[route] || 0) + score;
    }
  };

  // Detect express: router.get('/users', ...); Gin: r.Group("/api");
  // FastAPI: @app.get("/api") - a method-level (or Gin group) declaration,
  // not a full mount path, so it still goes through the root-segment
  // truncation above.
  const listenRouteRegex = /(?:app|router|r|server|http|mux)\.(?:get|post|put|delete|patch|all|Group|HandleFunc|Handle)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  // Express/Koa-style mounting: app.use('/api/x', subRouter) - the full path
  // IS the mount point, not a fragment of one.
  const mountRegex = /(?:app|router|server)\.use\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  const pythonRouteRegex = /@(?:app|router|server)\.(?:route|get|post|put|delete|patch)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  // Detect Spring (Java/Kotlin) method-level routes: @GetMapping(value = "/x"),
  // @PostMapping("/x"), etc.
  const springMethodRouteRegex = /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?\{?\s*['"`](\/[a-zA-Z0-9_\-\/{}]+)/gm;
  // Spring's class-level @RequestMapping("/x") is a full mount prefix, same
  // reasoning as Express's app.use above.
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

  if (Object.keys(mountScores).length > 0) {
    return Object.entries(mountScores).sort((a, b) => b[1] - a[1]).map(r => r[0]);
  }

  const sortedRoutes = Object.entries(routeScores).sort((a, b) => b[1] - a[1]);
  return sortedRoutes.map(r => r[0]);
}

module.exports = { analyzeBackendExposedRoutes, 
  analyzeFrontendRoutes
};
