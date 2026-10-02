const crypto = require('crypto');

// A route: the external path, and whether its prefix is stripped before the service sees it.

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

// Traefik applies middlewares per Ingress, so each stripped prefix gets its own. A hash is added only
// when two slugs collide.
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
