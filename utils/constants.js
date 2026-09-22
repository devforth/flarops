// Directories that never contain the project's own application code. The
// JS-centric entries were the original list; everything after them is
// dependency or build output for another ecosystem, which used to be walked
// and scanned exactly like first-party source - so a vendored library's own
// ports, routes and env var reads were attributed to the user's service (and
// on a large Go/Java repo, scanning them dominated the run time).
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
  // A repository's OWN deployment manifests describe infrastructure, not the
  // application's source configuration - reading them back attributes a
  // Service's targetPort or a ConfigMap's SERVER_PORT to whichever service
  // happens to be scanned, and a project that already ships k8s/ or a Helm
  // chart had those numbers turn up as its containers' listen ports.
  'k8s',
  'kubernetes',
  'manifests',
  'helm',
  'charts',
  'terraform',
  '.terraform',
  // Go, PHP
  'vendor',
  // Maven, Gradle, Rust, sbt
  'target',
  '.gradle',
  // Python
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  'site-packages',
  // .NET
  'obj',
  // CocoaPods
  'Pods'
]);

const SENSITIVE_REGEX = /(PASSWORD|PASS|KEY|SECRET|TOKEN|CREDENTIALS|AUTH|SALT|CERT)/i;
const DB_PASSWORD_REGEX = /^(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)$/i;

const COMMON_API_PREFIXES = ['/api', '/graphql', '/backend', '/v1', '/v2', '/rpc', '/trpc', '/socket.io'];

// Directories that never contain a deployable service of this project, even
// when they hold a Dockerfile.
//
// Two kinds of entry: dependency/build output (vendor, target, venv), and a
// repository's own deployment manifests - a k8s/ or helm/ folder routinely
// ships a Dockerfile per component for reference, and treating those as
// services generates duplicates of things already deployed from their real
// source.
//
// The list must only hold names that cannot plausibly be a user's own
// service. "dashboard" and "templates" used to be here to stop Flarops' own
// embedded copies from being detected, but both are perfectly ordinary
// service names, so a real dashboard/ microservice was silently never
// deployed. Flarops' own copy lives under deploy/ once generated, and is
// recognised by module name otherwise - see isFlaropsOwnDashboard.
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

module.exports = {
  IGNORED_DIRS,
  SENSITIVE_REGEX,
  DB_PASSWORD_REGEX,
  COMMON_API_PREFIXES,
  DB_PORTS,
  SERVICE_SCAN_IGNORED_DIRS
};
