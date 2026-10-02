// Directories that never contain the project's own application code.
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
  '.keys',
  // A repository's own deployment manifests: read back, their ports would be taken for the app's.
  'k8s',
  'kubernetes',
  'manifests',
  'helm',
  'charts',
  'terraform',
  '.terraform',
  'vendor',
  'target',
  '.gradle',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  'site-packages',
  'obj',
  'Pods'
]);

const SENSITIVE_REGEX = /(PASSWORD|PASS|KEY|SECRET|TOKEN|CREDENTIALS|AUTH|SALT|CERT)/i;
const DB_PASSWORD_REGEX = /^(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)$/i;

const COMMON_API_PREFIXES = ['/api', '/graphql', '/backend', '/v1', '/v2', '/rpc', '/trpc', '/socket.io'];

// Directories that never hold a deployable service, even when they contain a Dockerfile.
const SERVICE_SCAN_IGNORED_DIRS = new Set([
  'node_modules', 'deploy', 'dist', 'build', 'vendor', 'target', 'venv', '.venv',
  'k8s', 'kubernetes', 'manifests', 'helm', 'charts', 'terraform', '.terraform',
  'docs', 'examples', 'test', 'tests', '__tests__', 'e2e',
]);

const DB_PORTS = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  sqlite: 0
};

// Any address meaning "this machine". Looser than the rewrite pattern on purpose: it only flags.
const LOOPBACK_HOST_REGEX = /(^|[^A-Za-z0-9.-])(?:[A-Za-z0-9-]+\.)*localhost\b|\b127\.0\.0\.1\b|\b0\.0\.0\.0\b|\[::1\]/i;

module.exports = {
  LOOPBACK_HOST_REGEX,
  IGNORED_DIRS,
  SENSITIVE_REGEX,
  DB_PASSWORD_REGEX,
  COMMON_API_PREFIXES,
  DB_PORTS,
  SERVICE_SCAN_IGNORED_DIRS
};
