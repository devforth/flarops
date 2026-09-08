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

  const addRoute = (route, score) => {
    const root = getRootSegment(route);
    if (root && root !== '/') {
      routeScores[root] = (routeScores[root] || 0) + score;
    }
  };

  // Detect express: app.use('/api', ...), router.get('/users', ...)
  // Detect Gin: r.Group("/api")
  // Detect FastAPI: @app.get("/api")
  const listenRouteRegex = /(?:app|router|r|server|http|mux)\.(?:use|get|post|put|delete|patch|all|Group|HandleFunc|Handle)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  const pythonRouteRegex = /@(?:app|router|server)\.(?:route|get|post|put|delete|patch)\s*\(\s*['"`](\/[a-zA-Z0-9_\-\/]+)/gim;
  
  for (const filePath of filesToScan) {
    if (filePath.includes('node_modules') || filePath.includes('.git') || filePath.includes('dist')) continue;
    try {
      const ext = path.extname(filePath);
      if (!['.js', '.ts', '.go', '.py', '.java', '.php', '.rb'].includes(ext)) continue;
      
      const fileContent = await fs.readFile(filePath, 'utf8');
      
      let match;
      while ((match = listenRouteRegex.exec(fileContent)) !== null) {
        addRoute(match[1], 1);
      }
      while ((match = pythonRouteRegex.exec(fileContent)) !== null) {
        addRoute(match[1], 1);
      }
    } catch (e) {}
  }
  
  const sortedRoutes = Object.entries(routeScores).sort((a, b) => b[1] - a[1]);
  return sortedRoutes.map(r => r[0]);
}

module.exports = { analyzeBackendExposedRoutes, 
  analyzeFrontendRoutes
};
