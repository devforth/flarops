// One answer per question about a database engine.
//
// These were computed inline in five places and had already drifted: MySQL's
// default user was "root" in four of them and "mysql" in the fifth - the one
// that feeds values.yaml, so the chart created a user the API was never told
// about. The engine's own conventions belong in one table, not in a ladder
// repeated wherever someone needed it.

const { DB_PORTS } = require('./constants');

// Canonical per-engine facts, keyed by the dbType strings the analyzers emit.
// "postgresql" is an alias the analyzer also produces.
// The image tag is PINNED here, not looked up. It used to be resolved by
// asking Docker Hub for the tag list and taking the highest number, which made
// generation depend on the day it ran: the same repository produced a
// different deployment each time a registry published something, the test
// suite's output snapshots moved with it, and the newest number is not
// necessarily a version the project's own code can run against.
//
// Pinned to the current newest major, at the major level so patch releases
// still flow in without regenerating anything - which is how a compose file
// would normally pin it too. Raising one of these is an edit here, made
// deliberately.
const ENGINES = {
  postgres:   { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',          port: DB_PORTS.postgres, image: 'postgres:18-alpine' },
  postgresql: { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',          port: DB_PORTS.postgres, image: 'postgres:18-alpine' },
  mysql:      { user: 'root',     passwordKey: 'MYSQL_ROOT_PASSWORD',        port: DB_PORTS.mysql,    image: 'mysql:26' },
  mariadb:    { user: 'root',     passwordKey: 'MARIADB_ROOT_PASSWORD',      port: DB_PORTS.mariadb,  image: 'mariadb:13' },
  mongodb:    { user: 'root',     passwordKey: 'MONGO_INITDB_ROOT_PASSWORD', port: DB_PORTS.mongodb,  image: 'mongo:8' },
};

// Postgres is the fallback because it is also the image init.js falls back to
// when no engine was detected - answering with a different engine's user would
// contradict the container that actually gets deployed.
const FALLBACK = ENGINES.postgres;

function engineOf(dbType) {
  return ENGINES[String(dbType || '').toLowerCase()] || FALLBACK;
}

function defaultUserFor(dbType) { return engineOf(dbType).user; }
function defaultImageFor(dbType) { return engineOf(dbType).image; }
function defaultPortFor(dbType) { return engineOf(dbType).port; }
function passwordKeyFor(dbType) { return engineOf(dbType).passwordKey; }

// The scheme a database URL Flarops builds is written with.
//
// The URL is rebuilt against the cluster's own host and password, but the
// scheme belongs to the application: "postgresql+asyncpg" names a driver,
// and "postgres" vs "postgresql" is not a matter of taste - SQLAlchemy 1.4+
// rejects "postgres://" outright (NoSuchModuleError), so a FastAPI backend
// whose compose file said "postgresql://..." could not even import once the
// generated URL replaced it. The scheme the project used is kept when it is
// one of this engine's; otherwise the form every driver accepts is used.
const URL_SCHEME_FAMILY = {
  postgres: /^postgres(ql)?(\+[a-z0-9_]+)?$/,
  postgresql: /^postgres(ql)?(\+[a-z0-9_]+)?$/,
  mysql: /^(mysql|mariadb)(\+[a-z0-9_]+)?$/,
  mariadb: /^(mysql|mariadb)(\+[a-z0-9_]+)?$/,
  // Not mongodb+srv: that form resolves a DNS SRV record instead of host:port,
  // and the generated URL always names the Service and its port.
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

// "postgresql+asyncpg://..." -> "postgresql+asyncpg"; null for anything else.
function urlSchemeOf(value) {
  const m = String(value == null ? '' : value).trim().replace(/^["']|["']$/g, '').match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = {
  defaultImageFor, defaultUserFor, defaultPortFor, passwordKeyFor, dbUrlScheme, urlSchemeOf, ENGINES };
