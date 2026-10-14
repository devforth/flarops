// What sync tells the user: the changes in flarops.yaml's own terms (a field, its old and new value),
// the GitHub Secrets to create or drop, and what a change does not do to data already on disk.

const { claimNameFor } = require('../templates/generic/volumes.js');
const { ENGINES, defaultDataPathFor } = require('./dbDefaults.js');

const none = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

function show(v) {
  if (none(v)) return 'none';
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// One line per field that differs: "label: old -> new", "label: added (value)", "label: removed".
function fieldLines(label, from, to, out) {
  if (none(from) && none(to)) return;
  if (none(from)) { out.push(`${label}: added (${show(to)})`); return; }
  if (none(to)) { out.push(`${label}: removed (was ${show(from)})`); return; }
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (plain(from) && plain(to)) {
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) fieldLines(`${label}.${key}`, from[key], to[key], out);
    return;
  }
  if (JSON.stringify(from) !== JSON.stringify(to)) out.push(`${label}: ${show(from)} -> ${show(to)}`);
}

// Volumes as flarops.yaml writes them: by name, with path and size.
function volumeLines(label, from, to, out) {
  const byName = (list) => new Map((list || []).map(v => [v.name, { path: v.target, size: v.size }]));
  const a = byName(from);
  const b = byName(to);
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(name);
    const now = b.get(name);
    if (!was) out.push(`${label}.${name}: added (${now.path}${now.size ? `, ${now.size}` : ''})`);
    else if (!now) out.push(`${label}.${name}: removed`);
    else fieldLines(`${label}.${name}`, was, now, out);
  }
}

// A db: block, with the fields flarops.yaml has and none of the internal ones.
function dbView(db) {
  if (!db || db.shared) return null;
  return {
    type: db.type, image: db.image, port: db.port, user: db.user, name: db.name, replicas: db.replicas,
    command: db.command, password: db.passwordKey,
  };
}

function formatChanges(changes) {
  const lines = [];
  const secretsAdded = [];
  const secretsRemoved = [];
  const secretEnvs = new Map(); // "api.secretEnvs.X" -> { from, to }
  const touchSecret = (key, field, value) => {
    if (!secretEnvs.has(key)) secretEnvs.set(key, { from: null, to: null });
    secretEnvs.get(key)[field] = value;
  };

  for (const c of changes) {
    const m = c.label.match(/^(.*?)(?:: (.*))?$/);
    const label = m[1];
    if (/^GitHub Secret /.test(label)) {
      const key = label.replace(/^GitHub Secret /, '');
      (/now required/.test(c.label) ? secretsAdded : secretsRemoved).push(key);
      continue;
    }
    if (/created from the shared template/.test(c.label)) { lines.push(`+ ${label} (new service)`); continue; }
    if (/no longer declared, removed/.test(c.label)) { lines.push(`- ${label} (removed)`); continue; }
    if (/ present$/.test(label)) { if (c.to) lines.push(`+ ${label.replace(/ present$/, '')}`); continue; }
    if (/ removed$/.test(label) && !/\.db removed$/.test(label)) { if (c.to === false || c.to === null) lines.push(`- ${label.replace(/ removed$/, '')}`); continue; }
    if (/\(top-level database\)$/.test(label)) continue; // follows from database.*

    const owner = label.replace(/\.secretEnvs \((same name|renamed)\)$/, '');
    if (/\.secretEnvs \(same name\)$/.test(label)) {
      for (const k of c.from || []) touchSecret(`${owner}.secretEnvs.${k}`, 'from', k);
      for (const k of c.to || []) touchSecret(`${owner}.secretEnvs.${k}`, 'to', k);
      continue;
    }
    if (/\.secretEnvs \(renamed\)$/.test(label)) {
      for (const mp of c.from || []) touchSecret(`${owner}.secretEnvs.${mp.envName}`, 'from', mp.secretKey);
      for (const mp of c.to || []) touchSecret(`${owner}.secretEnvs.${mp.envName}`, 'to', mp.secretKey);
      continue;
    }
    if (/\.databaseUrls$/.test(label) && (Array.isArray(c.from) || Array.isArray(c.to))) {
      const a = new Set((c.from || []).map(v => v.key));
      const b = new Set((c.to || []).map(v => v.key));
      for (const k of b) if (!a.has(k)) lines.push(`${label}: + ${k}`);
      for (const k of a) if (!b.has(k)) lines.push(`${label}: - ${k}`);
      continue;
    }
    if (/\.volumes$/.test(label)) { volumeLines(label, c.from, c.to, lines); continue; }
    if (/\.db( removed)?$/.test(label)) {
      const from = dbView(c.from);
      const to = dbView(c.to);
      const base = label.replace(/ removed$/, '');
      if (from && to) {
        volumeLines(`${base}.volumes`, c.from.volumes, c.to.volumes, lines);
        fieldLines(base, from, to, lines);
      } else if (to) lines.push(`${base}: added (own ${to.type} database)`);
      else if (from) lines.push(`${base}: removed (own database)`);
      continue;
    }
    fieldLines(label, c.from, c.to, lines);
  }
  for (const [key, { from, to }] of secretEnvs) {
    if (from === to) continue;
    lines.push(from === null ? `${key}: added (from GitHub Secret ${to})` : to === null ? `${key}: removed` : `${key}: ${from} -> ${to}`);
  }
  return { lines, secretsAdded, secretsRemoved };
}

// Who reads each GitHub Secret, from flarops.yaml: "api as STRIPE_KEY".
function secretReaders(declared) {
  const readers = new Map();
  const add = (key, who) => { if (!readers.has(key)) readers.set(key, []); readers.get(key).push(who); };
  for (const [name, decl] of declared) {
    for (const [env, key] of Object.entries(decl.secretEnvs || {})) add(String(key), env === key ? name : `${name} as ${env}`);
    for (const key of Object.values((decl.db || {}).secretEnvs || {})) add(String(key), `${name}'s database password`);
  }
  return readers;
}

const major = (image) => ((String(image || '').split(':')[1] || '').match(/^(\d+)/) || [])[1];
const engine = (type) => (/^postgres/.test(String(type).toLowerCase()) ? 'postgres' : String(type).toLowerCase());
// Where an engine's image keeps its data, in any version (Postgres 18 moved it).
const dataPaths = (type) => [defaultDataPathFor(type, ''), defaultDataPathFor(type, `${type}:18`)];

// What the change does not do to what is already deployed: a database keeps the name, user and password
// it was created with, an image major version does not upgrade a data directory, and data stays in
// the claims of a removed or renamed service.
function dataNotes(before, after) {
  const notes = [];
  const dbNotes = (label, was, now) => {
    if (!was || !now) return;
    if (was.name && now.name && was.name !== now.name) notes.push(`${label}.name changed (${was.name} -> ${now.name}): a database already created keeps "${was.name}" - the server creates a database only on its first start. Create "${now.name}" in it (or move the data) before the app connects.`);
    if (was.user && now.user && was.user !== now.user) notes.push(`${label}.user changed (${was.user} -> ${now.user}): a database already created keeps its first user. Create "${now.user}" in it, or keep the old name.`);
    if (was.passwordKey && now.passwordKey && was.passwordKey !== now.passwordKey) notes.push(`${label}'s password now comes from ${now.passwordKey} (was ${was.passwordKey}): a database already created keeps its first password. Give ${now.passwordKey} the same value, or change the password inside the database too.`);
    const engineChanged = was.type && now.type && engine(was.type) !== engine(now.type);
    if (engineChanged) {
      notes.push(`${label}.type changed (${was.type} -> ${now.type}): this is a different database engine, and ${now.type} cannot read the data ${was.type} left on the disk. Dump the data with ${was.type}'s tools, deploy, and load it into ${now.type} - or start empty.`);
      const data = (now.volumes || []).find(v => v.name === 'data');
      const owner = data && !dataPaths(now.type).includes(data.target) && Object.keys(ENGINES).find(t => dataPaths(t).includes(data.target));
      if (owner) notes.push(`${label}.volumes: the "data" volume is still mounted at ${data.target}, where ${owner} keeps its data - ${now.type} keeps it at ${defaultDataPathFor(now.type, now.image)}, so its data would not reach the disk. Set that path for "data" under ${label}.volumes (or leave the data volume out to get it).`);
    } else if (major(was.image) && major(now.image) && major(was.image) !== major(now.image)) {
      notes.push(`${label}.image moves to a new major version (${was.image} -> ${now.image}): the existing data directory will not start under it. Dump the data, recreate the database, and restore.`);
    }
    if (engineChanged && was.image === now.image) notes.push(`${label}.type changed to ${now.type} but image is still ${now.image} - set an image for ${now.type} too.`);
  };
  if (before.hasDb && after.hasDb) {
    dbNotes('database', { name: before.dbName, user: before.dbUser, passwordKey: before.dbPasswordKey, image: before.images && before.images.db, type: before.dbType },
      { name: after.dbName, user: after.dbUser, passwordKey: after.dbPasswordKey, image: after.images && after.images.db, type: after.dbType, volumes: after.dbVolumes });
  }

  const all = (s) => [...(s.additionalServices || []), ...(s.supportServices || [])];
  const now = new Map(all(after).map(s => [s.name, s]));
  const added = all(after).filter(s => !all(before).some(b => b.name === s.name));
  for (const was of all(before)) {
    const cur = now.get(was.name);
    if (cur) {
      if (was.db && !was.db.shared && cur.db && !cur.db.shared) dbNotes(`${was.name}.db`, was.db, cur.db);
      continue;
    }
    const claims = (was.volumes || []).map(v => claimNameFor(was.name, v.name));
    if (was.db && !was.db.shared) claims.push(`data-${was.name}-db-0`);
    if (claims.length === 0) continue;
    const renamed = added.find(s => (s.volumes || []).length > 0 || (s.db && !s.db.shared));
    notes.push(renamed
      ? `${was.name} was removed and ${renamed.name} added. If this is a rename, the data did not move: it is still in ${claims.join(', ')}, and ${renamed.name} starts empty.`
      : `${was.name} was removed; its data stays in ${claims.join(', ')} - "kubectl delete pvc ${claims.join(' ')}" once nothing needs it.`);
  }
  return notes;
}

module.exports = { formatChanges, secretReaders, dataNotes };
