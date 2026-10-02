// Per-engine defaults, in one place.

const { DB_PORTS } = require('./constants');

// Image tags are pinned here and raised deliberately, never looked up at generation time.
const ENGINES = {
  postgres:   { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',          port: DB_PORTS.postgres, image: 'postgres:18-alpine' },
  postgresql: { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',          port: DB_PORTS.postgres, image: 'postgres:18-alpine' },
  mysql:      { user: 'root',     passwordKey: 'MYSQL_ROOT_PASSWORD',        port: DB_PORTS.mysql,    image: 'mysql:26' },
  mariadb:    { user: 'root',     passwordKey: 'MARIADB_ROOT_PASSWORD',      port: DB_PORTS.mariadb,  image: 'mariadb:13' },
  mongodb:    { user: 'root',     passwordKey: 'MONGO_INITDB_ROOT_PASSWORD', port: DB_PORTS.mongodb,  image: 'mongo:8' },
};

// Postgres: the same engine init.js falls back to when none is detected.
const FALLBACK = ENGINES.postgres;

function engineOf(dbType) {
  return ENGINES[String(dbType || '').toLowerCase()] || FALLBACK;
}

function defaultUserFor(dbType) { return engineOf(dbType).user; }
function defaultImageFor(dbType) { return engineOf(dbType).image; }
function defaultPortFor(dbType) { return engineOf(dbType).port; }
function passwordKeyFor(dbType) { return engineOf(dbType).passwordKey; }

// Keep the project's own scheme - it names the driver. SQLAlchemy 1.4+ rejects "postgres://".
const URL_SCHEME_FAMILY = {
  postgres: /^postgres(ql)?(\+[a-z0-9_]+)?$/,
  postgresql: /^postgres(ql)?(\+[a-z0-9_]+)?$/,
  mysql: /^(mysql|mariadb)(\+[a-z0-9_]+)?$/,
  mariadb: /^(mysql|mariadb)(\+[a-z0-9_]+)?$/,
  // Not mongodb+srv: the generated URL names a host and a port.
  mongodb: /^mongodb$/,
};
const DEFAULT_URL_SCHEME = { postgres: 'postgresql', postgresql: 'postgresql', mysql: 'mysql', mariadb: 'mysql', mongodb: 'mongodb' };

function dbUrlScheme(dbType, recorded) {
  const type = String(dbType || '').toLowerCase();
  const family = URL_SCHEME_FAMILY[type];
  const scheme = String(recorded || '').toLowerCase();
  if (family && family.test(scheme)) return scheme;
  return DEFAULT_URL_SCHEME[type] || 'postgresql';
}

function urlSchemeOf(value) {
  const m = String(value == null ? '' : value).trim().replace(/^["']|["']$/g, '').match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = {
  defaultImageFor, defaultUserFor, defaultPortFor, passwordKeyFor, dbUrlScheme, urlSchemeOf, ENGINES };
