const IGNORED_DIRS = new Set([
  'node_modules', 
  '.git', 
  'dist', 
  'build', 
  '.next', 
  'coverage', 
  '.nuxt', 
  '.output', 
  '.cache',
  'out',
  'deploy',
  '.keys'
]);

const SENSITIVE_REGEX = /(PASSWORD|PASS|KEY|SECRET|TOKEN|CREDENTIALS|AUTH|SALT|CERT)/i;
const DB_PASSWORD_REGEX = /^(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)$/i;

const COMMON_API_PREFIXES = ['/api', '/graphql', '/backend', '/v1', '/v2', '/rpc', '/trpc', '/socket.io'];

// Directories that are never a real deployable frontend/service, even if they contain a Dockerfile
// (Flarops' own generated/embedded output living inside the scanned project).
const SERVICE_SCAN_IGNORED_DIRS = new Set(['node_modules', 'deploy', 'dist', 'build', 'templates', 'dashboard']);

const DB_PORTS = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  sqlite: 0
};

module.exports = {
  IGNORED_DIRS,
  SENSITIVE_REGEX,
  DB_PASSWORD_REGEX,
  COMMON_API_PREFIXES,
  DB_PORTS,
  SERVICE_SCAN_IGNORED_DIRS
};
