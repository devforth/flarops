const crypto = require('crypto');

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

// Kubernetes object names for the middlewares that strip a prefix. Traefik
// applies middlewares per INGRESS, not per path, so each distinct prefix needs
// its own middleware and its own Ingress carrying the annotation.
//
// The name is a slug of the path, and a slug loses information: every run of
// non-alphanumerics becomes one dash, so "/a/b" and "/a-b" - both perfectly
// ordinary paths - produced the SAME name. Two Middleware objects with one
// name means the second silently replaces the first on apply, and one of the
// two routes then strips the other's prefix. Nothing says so.
//
// Names are therefore assigned for the whole set at once: a slug that is
// unique keeps its readable name, and only a colliding one carries a short
// hash of its full path. That way the common project reads as
// "<project>-strip-api" in kubectl, and a name never changes because some
// unrelated route was added elsewhere - the hash depends on the path alone.
function stripMiddlewareNames(projectName, paths) {
  const slugOf = (p) => String(p).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';

  const bySlug = new Map();
  for (const p of paths) {
    const slug = slugOf(p);
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(p);
  }

  const names = new Map();
  const taken = new Set();
  for (const [slug, group] of bySlug) {
    for (const p of group) {
      const name = group.length === 1
        ? `${projectName}-strip-${slug}`
        : `${projectName}-strip-${slug}-${crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 6)}`;
      // A path that still collides after the hash cannot be told apart at all.
      // This should never happen; if it does, generating anyway would mean
      // shipping the very ambiguity the hash exists to remove.
      if (taken.has(name)) {
        const other = [...names.keys()].find(k => names.get(k) === name);
        throw new Error(
          `Two exposed routes produce the same Kubernetes object name "${name}": ` +
          `${other} and ${p}. Rename one of them in flarops.yaml.`
        );
      }
      taken.add(name);
      names.set(p, name);
    }
  }
  return names;
}

module.exports = { normalizeRoute, normalizeRoutes, stripMiddlewareNames };
