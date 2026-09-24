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
const ENGINES = {
  postgres:   { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',        port: DB_PORTS.postgres },
  postgresql: { user: 'postgres', passwordKey: 'POSTGRES_PASSWORD',        port: DB_PORTS.postgres },
  mysql:      { user: 'root',     passwordKey: 'MYSQL_ROOT_PASSWORD',      port: DB_PORTS.mysql },
  mariadb:    { user: 'root',     passwordKey: 'MARIADB_ROOT_PASSWORD',    port: DB_PORTS.mariadb },
  mongodb:    { user: 'root',     passwordKey: 'MONGO_INITDB_ROOT_PASSWORD', port: DB_PORTS.mongodb },
};

// Postgres is the fallback because it is also the image init.js falls back to
// when no engine was detected - answering with a different engine's user would
// contradict the container that actually gets deployed.
const FALLBACK = ENGINES.postgres;

function engineOf(dbType) {
  return ENGINES[String(dbType || '').toLowerCase()] || FALLBACK;
}

function defaultUserFor(dbType) { return engineOf(dbType).user; }
function defaultPortFor(dbType) { return engineOf(dbType).port; }
function passwordKeyFor(dbType) { return engineOf(dbType).passwordKey; }

module.exports = { defaultUserFor, defaultPortFor, passwordKeyFor, ENGINES };
