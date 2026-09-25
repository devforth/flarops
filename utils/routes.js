// An exposed route: the path the OUTSIDE world uses, plus what has to happen
// to a request before the service behind it sees it.
//
// Until now a route was a bare string, because Flarops derived the external
// path space from the service's own internal routes - true only while the
// service is mounted at the root. A reverse proxy in front that rewrites the
// path (docker-compose's "stripprefix" middleware, the shape every project
// with an SPA and an API under /api uses) breaks that assumption: the browser
// asks for /api/auth/me and the backend serves /auth/me. With no way to say
// so, the generated Ingress passed /api/... through untouched, the backend
// answered 404, and - because the catch-all "/" rule sent it to the frontend
// instead - the browser got HTML where it expected JSON.
//
// So a route carries its own transformation. The short form stays: most routes
// need none, and writing them as objects would be noise.
//
//   exposedRoutes:
//     - /click                  # passed through as-is
//     - path: /api              # backend sees the request without "/api"
//       stripPrefix: true

function normalizeRoute(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return { path: entry, stripPrefix: false };
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const path = entry.path === undefined || entry.path === null ? null : String(entry.path);
    if (!path) return null;
    return { path, stripPrefix: !!entry.stripPrefix };
  }
  return { path: String(entry), stripPrefix: false };
}

function normalizeRoutes(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRoute).filter(Boolean);
}

// The path alone, for the places that only care where a request goes - route
// ownership, conflict reporting, the gateway checks.
function routePaths(list) {
  return normalizeRoutes(list).map(r => r.path);
}

// A Kubernetes object name for the middleware that strips one prefix. Traefik
// applies middlewares per INGRESS, not per path, so each distinct prefix needs
// its own middleware and its own Ingress carrying the annotation.
function stripMiddlewareName(projectName, path) {
  const slug = String(path).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${projectName}-strip-${slug || 'root'}`;
}

module.exports = { normalizeRoute, normalizeRoutes, routePaths, stripMiddlewareName };
