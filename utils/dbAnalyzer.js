const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { walkDir, logDebug } = require('./fsHelper');
const { DB_PORTS } = require('./constants');

function fetchDockerTags(image) {
  return new Promise((resolve) => {
    https.get(`https://registry.hub.docker.com/v2/repositories/library/${image}/tags/?page_size=100`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.results ? parsed.results.map(t => t.name) : []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

async function getLatestDbImage(dbType) {
  let image = 'postgres';
  if (dbType === 'mysql') image = 'mysql';
  else if (dbType === 'mariadb') image = 'mariadb';
  else if (dbType === 'mongodb') image = 'mongo';
  else return null;

  const tags = await fetchDockerTags(image);
  let validTags = tags.filter(t => /^\d+(\.\d+)*$/.test(t));

  if (dbType === 'postgres') {
    const alpineTags = tags.filter(t => /^\d+(\.\d+)*-alpine$/.test(t));
    if (alpineTags.length > 0) validTags = alpineTags;
  }
  
  if (validTags.length === 0) {
    if (dbType === 'postgres') return 'postgres:15-alpine';
    if (dbType === 'mysql') return 'mysql:8';
    if (dbType === 'mariadb') return 'mariadb:10';
    if (dbType === 'mongodb') return 'mongo:latest';
  }

  validTags.sort((a, b) => {
    const vA = a.replace('-alpine', '').split('.').map(Number);
    const vB = b.replace('-alpine', '').split('.').map(Number);
    for (let i = 0; i < Math.max(vA.length, vB.length); i++) {
      const numA = vA[i] || 0;
      const numB = vB[i] || 0;
      if (numA !== numB) return numB - numA;
    }
    return 0;
  });

  return `${image}:${validTags[0]}`;
}

// If the project's own docker-compose.yml pins a specific image/tag for the
// database (e.g. "image: mysql:5.6"), prefer that over auto-fetching the
// latest tag from Docker Hub. The project's application code (driver
// versions, auth plugin assumptions, SQL dialect quirks) was written and
// tested against whatever version the author actually pinned - silently
// upgrading to "latest" can break compatibility outright (e.g. an old
// mysql-connector-java client that can't speak MySQL 8's default
// caching_sha2_password auth plugin / TLS requirements).
async function findPinnedDbImageTag(baseDir, dbType) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  const engineNames = {
    postgres: 'postgres(?:ql)?',
    mysql: 'mysql',
    mariadb: 'mariadb',
    mongodb: 'mongo'
  };
  const engine = engineNames[dbType];
  if (!engine) return null;

  const imageRegex = new RegExp(`image:\\s*["']?((?:[a-zA-Z0-9_.-]+/)?${engine}:[a-zA-Z0-9_.-]+)["']?`, 'i');

  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      const match = content.match(imageRegex);
      if (match) return match[1];
    } catch (e) { logDebug(e); }
  }
  return null;
}



function testRegex(content, regexString) {
  const regex = new RegExp(`^(?!\\s*(?:#|\\/\\/)).*${regexString}`, 'im');
  return regex.test(content);
}

async function checkEnvVars(baseDir, backendPath, onlyFiles = ['.env']) {
  const dirsToScan = [baseDir, backendPath];
  const checks = [];

  for (const dir of dirsToScan) {
    for (const file of onlyFiles) {
      checks.push((async () => {
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf8');
          if (testRegex(content, 'postgres(?:ql)?:\\/\\/') || testRegex(content, 'POSTGRES_USER')) {
            return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
          }
          if (testRegex(content, 'mysql:\\/\\/') || testRegex(content, 'MYSQL_DATABASE')) {
            return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
          }
          if (testRegex(content, 'mariadb:\\/\\/') || testRegex(content, 'MARIADB_DATABASE')) {
            return { hasDb: true, dbType: 'mariadb', port: DB_PORTS.mariadb };
          }
          if (testRegex(content, 'mongodb(?:\\+srv)?:\\/\\/') || testRegex(content, 'MONGO_URI')) {
            return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
          }
        } catch (e) { logDebug(e); }
        return null;
      })());
    }
  }

  const results = await Promise.all(checks);
  return results.find(r => r !== null) || null;
}

async function checkORM(baseDir, backendPath) {
  const dirsToScan = [baseDir, backendPath];
  const checks = [];

  for (const dir of dirsToScan) {
    checks.push((async () => {
      try {
        const prismaContent = await fs.readFile(path.join(dir, 'prisma', 'schema.prisma'), 'utf8');
        if (testRegex(prismaContent, 'provider\\s*=\\s*["\']postgresql["\']')) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
        if (testRegex(prismaContent, 'provider\\s*=\\s*["\']mysql["\']')) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
        if (testRegex(prismaContent, 'provider\\s*=\\s*["\']mongodb["\']')) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
        if (testRegex(prismaContent, 'provider\\s*=\\s*["\']sqlite["\']')) return { hasDb: true, dbType: 'sqlite', port: DB_PORTS.sqlite };
      } catch (e) { logDebug(e); }

      const typeormFiles = ['ormconfig.json', 'typeorm.config.ts', 'typeorm.config.js'];
      for (const file of typeormFiles) {
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf8');
          if (testRegex(content, 'type\\s*[:=]\\s*["\']postgres["\']')) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mysql["\']')) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mariadb["\']')) return { hasDb: true, dbType: 'mariadb', port: DB_PORTS.mariadb };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mongodb["\']')) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
        } catch (e) { logDebug(e); }
      }
      return null;
    })());
  }

  const results = await Promise.all(checks);
  return results.find(r => r !== null) || null;
}

async function checkPackageJson(backendPath) {
  try {
    const pkgPath = path.join(backendPath, 'package.json');
    const content = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (deps['pg'] || deps['pg-promise']) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
    if (deps['mysql2'] || deps['mysql']) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
    if (deps['mariadb']) return { hasDb: true, dbType: 'mariadb', port: DB_PORTS.mariadb };
    if (deps['mongoose'] || deps['mongodb']) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
    if (deps['sqlite3']) return { hasDb: true, dbType: 'sqlite', port: DB_PORTS.sqlite };
  } catch (err) { logDebug(err); }
  return null;
}

async function checkRequirementsTxt(backendPath) {
  try {
    const reqPath = path.join(backendPath, 'requirements.txt');
    const content = await fs.readFile(reqPath, 'utf8');
    const lines = content.split('\n').map(l => l.toLowerCase());
    
    for (const line of lines) {
      if (line.includes('psycopg2') || line.includes('asyncpg') || line.includes('sqlalchemy')) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres }; // Defaulting SQLAlchemy to Postgres, common
      if (line.includes('mysqlclient') || line.includes('pymysql')) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
      if (line.includes('pymongo') || line.includes('mongoengine')) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
    }
  } catch (err) { logDebug(err); }
  return null;
}

// Dependency manifests for every ecosystem other than npm/pip. Without these,
// a Java, Go, Ruby, PHP, .NET or modern-Python (pyproject.toml) service had no
// first-party signal for its database at all and fell through to the
// project-wide compose/env scan - which can only ever name ONE database for
// the whole repo, no matter how many services and engines it actually has.
const DEPENDENCY_MANIFEST_MARKERS = [
  { file: 'pyproject.toml', rules: [
    [/psycopg|asyncpg|sqlalchemy/i, 'postgres'],
    [/pymysql|mysqlclient|aiomysql/i, 'mysql'],
    [/pymongo|motor|mongoengine|beanie/i, 'mongodb'],
  ]},
  { file: 'pom.xml', rules: [
    [/postgresql/i, 'postgres'],
    [/mariadb-java-client/i, 'mariadb'],
    [/mysql-connector|mysql:mysql/i, 'mysql'],
    [/mongodb-driver|data-mongodb/i, 'mongodb'],
  ]},
  { file: 'build.gradle', rules: [
    [/postgresql/i, 'postgres'],
    [/mariadb-java-client/i, 'mariadb'],
    [/mysql-connector|mysql:mysql/i, 'mysql'],
    [/mongodb-driver|data-mongodb/i, 'mongodb'],
  ]},
  { file: 'build.gradle.kts', rules: [
    [/postgresql/i, 'postgres'],
    [/mysql-connector/i, 'mysql'],
    [/mongodb-driver|data-mongodb/i, 'mongodb'],
  ]},
  { file: 'go.mod', rules: [
    [/lib\/pq|jackc\/pgx/i, 'postgres'],
    [/go-sql-driver\/mysql/i, 'mysql'],
    [/mongo-driver|mgo\.v2/i, 'mongodb'],
  ]},
  { file: 'Gemfile', rules: [
    [/^\s*gem\s+['"]pg['"]/im, 'postgres'],
    [/^\s*gem\s+['"]mysql2['"]/im, 'mysql'],
    [/^\s*gem\s+['"]mongoid['"]|^\s*gem\s+['"]mongo['"]/im, 'mongodb'],
  ]},
  { file: 'composer.json', rules: [
    [/pdo_pgsql|ext-pgsql/i, 'postgres'],
    [/pdo_mysql|ext-mysqli/i, 'mysql'],
    [/mongodb\/mongodb|ext-mongodb/i, 'mongodb'],
  ]},
];

async function checkDependencyManifests(backendPath) {
  for (const manifest of DEPENDENCY_MANIFEST_MARKERS) {
    let content;
    try {
      content = await fs.readFile(path.join(backendPath, manifest.file), 'utf8');
    } catch (e) { continue; }
    for (const [pattern, dbType] of manifest.rules) {
      if (pattern.test(content)) {
        return { hasDb: true, dbType, port: DB_PORTS[dbType] };
      }
    }
  }

  // .NET project files are named after the project, so they have to be
  // discovered rather than looked up by a fixed name.
  try {
    const entries = await fs.readdir(backendPath);
    for (const entry of entries) {
      if (!entry.endsWith('.csproj') && !entry.endsWith('.fsproj')) continue;
      const content = await fs.readFile(path.join(backendPath, entry), 'utf8');
      if (/Npgsql/i.test(content)) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
      if (/MySql\.Data|Pomelo\.EntityFrameworkCore\.MySql/i.test(content)) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
      if (/MongoDB\.Driver/i.test(content)) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
    }
  } catch (e) { logDebug(e); }

  return null;
}

// Example/template files (and documentation comments) are full of stand-in
// values - "<database>", "your-user", "changeme". Taking one as real config
// produces a database the application can never reach, so treat these the
// same as an unresolved ${...} reference: not a usable value.
function isUsableValue(value) {
  if (!value) return false;
  const v = String(value).trim();
  if (!v) return false;
  if (/\$\{?/.test(v)) return false;                 // unresolved reference
  if (/^<.*>$/.test(v)) return false;                // <database>, <user>
  if (/^(changeme|change_me|todo|tbd|xxx+|\.\.\.)$/i.test(v)) return false;
  if (/^(your|my|some|example|placeholder|replace)[-_]/i.test(v)) return false;
  return true;
}

// Credentials for ONE specific compose database service, read from that
// service's own block.
//
// extractDbCredentials below scans docker-compose.yml as a flat blob and
// takes the first match in the file. In a project running several databases
// that is simply whichever service was listed first: a microservice's own
// Postgres was created with POSTGRES_DB set to an unrelated component's
// database name, so the StatefulSet initialised a database the application
// never connects to and the pod failed on startup against a schema that did
// not exist. When the caller knows exactly which compose service backs this
// database - which it does whenever depends_on named it - read the block
// that actually describes it.
async function extractCredentialsFromComposeService(baseDir, composeServiceName, dbType) {
  if (!composeServiceName) return { user: null, name: null };
  const services = await parseComposeServices(baseDir);
  const svc = services[composeServiceName];
  if (!svc || !svc.block) return { user: null, name: null };

  const perTypeUserKeys = {
    postgres: 'POSTGRES_USER', postgresql: 'POSTGRES_USER',
    mysql: 'MYSQL_USER', mariadb: 'MARIADB_USER',
    mongodb: 'MONGO_INITDB_ROOT_USERNAME'
  };
  const perTypeNameKeys = {
    postgres: 'POSTGRES_DB', postgresql: 'POSTGRES_DB',
    mysql: 'MYSQL_DATABASE', mariadb: 'MARIADB_DATABASE',
    mongodb: 'MONGO_INITDB_DATABASE'
  };

  const read = (keyName) => {
    if (!keyName) return null;
    const m = svc.block.match(new RegExp(`^(?!\\s*#)\\s*(?:-\\s*)?${keyName}\\s*[:=]\\s*["']?([^"'\\s#]+)["']?`, 'im'));
    return m && isUsableValue(m[1]) ? m[1] : null;
  };

  return {
    user: read(perTypeUserKeys[dbType]) || read('DB_USER') || read('DATABASE_USER'),
    name: read(perTypeNameKeys[dbType]) || read('DB_NAME') || read('DATABASE_NAME'),
  };
}

async function extractDbCredentials(baseDir, backendPath, dbType) {
  const filesToScan = [
    path.join(baseDir, '.env'),
    path.join(baseDir, '.env.example'),
    backendPath ? path.join(backendPath, '.env') : null,
    backendPath ? path.join(backendPath, '.env.example') : null,
    path.join(baseDir, 'docker-compose.yml'),
    path.join(baseDir, 'docker-compose.yaml'),
    path.join(baseDir, 'compose.yml'),
    path.join(baseDir, 'compose.yaml')
  ].filter(Boolean);

  let dbUser = null;
  let dbName = null;

  // When the caller already knows which engine it's asking about, only match
  // that engine's own env var names/URL scheme. A project can genuinely
  // contain more than one database (a different one per service) - matching
  // every engine's keys unconditionally means whichever one happens to
  // appear first in a shared file (e.g. docker-compose.yml) wins the
  // credentials for a completely unrelated database.
  const perTypeUserKeys = {
    postgres: 'POSTGRES_USER', postgresql: 'POSTGRES_USER',
    mysql: 'MYSQL_USER', mariadb: 'MARIADB_USER',
    mongodb: 'MONGO_INITDB_ROOT_USERNAME'
  };
  const perTypeNameKeys = {
    postgres: 'POSTGRES_DB', postgresql: 'POSTGRES_DB',
    mysql: 'MYSQL_DATABASE', mariadb: 'MARIADB_DATABASE',
    mongodb: 'MONGO_INITDB_DATABASE'
  };
  const userKeys = dbType && perTypeUserKeys[dbType]
    ? `DATABASE_USER|DATABASE_USERNAME|DB_USER|DB_USERNAME|${perTypeUserKeys[dbType]}`
    : 'DATABASE_USER|DATABASE_USERNAME|DB_USER|DB_USERNAME|POSTGRES_USER|MYSQL_USER|MARIADB_USER|MONGO_INITDB_ROOT_USERNAME';
  const nameKeys = dbType && perTypeNameKeys[dbType]
    ? `DATABASE_DB|DB_NAME|DATABASE_NAME|${perTypeNameKeys[dbType]}`
    : 'DATABASE_DB|DB_NAME|DATABASE_NAME|POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE|MONGO_INITDB_DATABASE';

  const userRegex = new RegExp(`^(?!\\s*(?:#|\\/\\/))\\s*(?:-\\s*)?(?:${userKeys})[ \\t]*[:=][ \\t]*["']?([^"'\\s#]+|[^"'\\n]+)["']?`, 'im');
  const nameRegex = new RegExp(`^(?!\\s*(?:#|\\/\\/))\\s*(?:-\\s*)?(?:${nameKeys})[ \\t]*[:=][ \\t]*["']?([^"'\\s#]+|[^"'\\n]+)["']?`, 'im');

  // Every character class here excludes whitespace on purpose. With "[^@]*"
  // the match could run past the end of its own line hunting for an "@"
  // somewhere else in the file, so a credential-less URL like
  // "jdbc:postgresql://keycloak-postgres:5432/keycloak" paired its HOST with
  // an unrelated "@" further down and reported the host as the database user.
  const schemeRegexes = {
    postgres: /postgres(?:ql)?:\/\/([^:\/\s@]+):[^@\s]*@[^\/\s]+\/([^?\s]+)/i,
    postgresql: /postgres(?:ql)?:\/\/([^:\/\s@]+):[^@\s]*@[^\/\s]+\/([^?\s]+)/i,
    mysql: /mysql:\/\/([^:\/\s@]+):[^@\s]*@[^\/\s]+\/([^?\s]+)/i,
    mariadb: /mariadb:\/\/([^:\/\s@]+):[^@\s]*@[^\/\s]+\/([^?\s]+)/i,
    mongodb: /mongodb(?:\+srv)?:\/\/([^:\/\s@]+):[^@\s]*@[^\/\s]+\/([^?\s]+)/i
  };

  for (const file of filesToScan) {
    try {
      const rawContent = await fs.readFile(file, 'utf8');

      // The userRegex/nameRegex below already refuse commented-out lines, but
      // the URL match did not - so a documentation comment like
      // "# mongodb://<user>:<password>@<host>:<port>/<database>" was read as
      // real credentials and "<database>" became the database name. Strip
      // whole-line comments before matching anything.
      const content = rawContent
        .split('\n')
        .filter(line => !/^\s*(?:#|\/\/)/.test(line))
        .join('\n');

      const urlMatch = dbType && schemeRegexes[dbType]
        ? content.match(schemeRegexes[dbType])
        : content.match(schemeRegexes.postgres) ||
          content.match(schemeRegexes.mysql) ||
          content.match(schemeRegexes.mariadb) ||
          content.match(schemeRegexes.mongodb);

      if (urlMatch && !dbUser && !dbName) {
        if (isUsableValue(urlMatch[1])) dbUser = urlMatch[1];
        if (isUsableValue(urlMatch[2])) dbName = urlMatch[2];
        if (dbUser && dbName) return { user: dbUser, name: dbName };
      }

      if (!dbUser) {
        const userMatch = content.match(userRegex);
        if (userMatch && isUsableValue(userMatch[1])) dbUser = userMatch[1].trim();
      }

      if (!dbName) {
        const nameMatch = content.match(nameRegex);
        if (nameMatch && isUsableValue(nameMatch[1])) dbName = nameMatch[1].trim();
      }

      if (dbUser && dbName) {
         break;
      }
    } catch (e) { logDebug(e); }
  }

  return { user: dbUser, name: dbName };
}

// Maps a docker-compose image reference to the database engine it runs, or
// null when it isn't a database at all.
function composeImageDbType(image) {
  if (!image) return null;
  const img = String(image).toLowerCase();
  if (/postgres/.test(img)) return 'postgres';
  if (/mariadb/.test(img)) return 'mariadb';
  if (/mysql/.test(img)) return 'mysql';
  if (/mongo/.test(img)) return 'mongodb';
  return null;
}

// Which compose database service, if any, may serve as the PROJECT'S primary
// database - the one Flarops generates as the shared "database" StatefulSet.
//
// The old project-wide fallback simply took the first database image anywhere
// in docker-compose.yml, which in any multi-service repo is a coin flip: a
// microservice stack routinely runs several databases, and the first one
// listed is as likely to be an infrastructure component's private store
// (Keycloak's own schema, SonarQube's, a metrics backend's) as it is to be
// the application's. Picking that one produces a primary database named after
// somebody else's internals, and every service that really does share a
// database then gets pointed at it.
//
// depends_on states ownership explicitly: a database another service declares
// a dependency on is THAT service's database, not the project's - unless the
// service declaring it is the backend itself. A database nothing depends on
// has no stated owner and stays a valid project-wide candidate.
async function findComposeDatabaseCandidates(baseDir, backendPath) {
  const services = await parseComposeServices(baseDir);
  const names = Object.keys(services);
  if (names.length === 0) return null;

  const dbServices = names.filter(n => composeImageDbType(services[n].image));
  if (dbServices.length === 0) return null;

  const ownersOf = {};
  for (const n of names) {
    for (const dep of services[n].dependsOn || []) {
      if (dbServices.includes(dep)) {
        if (!ownersOf[dep]) ownersOf[dep] = [];
        ownersOf[dep].push(n);
      }
    }
  }

  const resolvedBackend = backendPath ? path.resolve(backendPath) : null;
  const backendService = resolvedBackend
    ? names.find(n => services[n].context && path.resolve(services[n].context) === resolvedBackend)
    : null;

  // Prefer a database the backend itself depends on; otherwise accept only
  // databases with no stated owner at all.
  const backendOwned = dbServices.filter(d => backendService && (ownersOf[d] || []).includes(backendService));
  const unowned = dbServices.filter(d => (ownersOf[d] || []).length === 0);
  const available = backendOwned.length > 0 ? backendOwned : unowned;

  return { services, dbServices, available, backendService, ownersOf };
}

async function checkDockerCompose(baseDir) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  // Match "image: postgres:15" as well as an org-prefixed/forked image like
  // "image: jmreif/mongodb" - the DB engine name doesn't have to be the first
  // path segment of the image reference.
  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      if (testRegex(content, 'image:\\s*["\']?(?:[a-zA-Z0-9_.-]+\\/)?postgres') || testRegex(content, 'POSTGRES_USER') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?5432"?')) {
        return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
      }
      if (testRegex(content, 'image:\\s*["\']?(?:[a-zA-Z0-9_.-]+\\/)?mysql') || testRegex(content, 'MYSQL_DATABASE') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?3306"?')) {
        return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
      }
      if (testRegex(content, 'image:\\s*["\']?(?:[a-zA-Z0-9_.-]+\\/)?mongo') || testRegex(content, 'MONGO_URI') || testRegex(content, 'MONGO_INITDB_') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?27017"?')) {
        return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
      }
    } catch(e) { logDebug(e); }
  }
  return null;
}

async function checkLocalDbDockerfile(baseDir) {
  // Fixed conventional names first (fast path)...
  const possibleDirs = ['db', 'database', 'postgres', 'mysql', 'mongo', 'sql', 'data', 'docker/db', 'docker/database', 'docker/postgres', 'docker/mysql', 'storage'];
  for (const dir of possibleDirs) {
    const fullPath = path.join(baseDir, dir);
    try {
      const files = await fs.readdir(fullPath);
      const dockerfileMatch = files.find(f => f.toLowerCase() === 'dockerfile' || f.toLowerCase().includes('dockerfile'));
      if (dockerfileMatch) {
        return path.join(dir, dockerfileMatch);
      }
    } catch(e) { logDebug(e); }
  }

  // ...then fall back to any top-level directory whose name merely *contains* a
  // DB engine keyword (e.g. "docker-mongodb", "postgres-init"), which the fixed
  // list above misses entirely.
  const dbNameKeywords = ['postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'redis'];
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const lowerName = entry.name.toLowerCase();
      if (!dbNameKeywords.some(k => lowerName.includes(k))) continue;
      if (possibleDirs.includes(lowerName)) continue; // already checked above

      const fullPath = path.join(baseDir, entry.name);
      try {
        const files = await fs.readdir(fullPath);
        const dockerfileMatch = files.find(f => f.toLowerCase() === 'dockerfile' || f.toLowerCase().includes('dockerfile'));
        if (dockerfileMatch) {
          return path.join(entry.name, dockerfileMatch);
        }
        // Dockerfile may live one level deeper (e.g. docker-mongodb/docker/Dockerfile)
        for (const sub of files) {
          const subPath = path.join(fullPath, sub);
          try {
            const subStat = await fs.stat(subPath);
            if (subStat.isDirectory()) {
              const subFiles = await fs.readdir(subPath);
              const subDockerfile = subFiles.find(f => f.toLowerCase() === 'dockerfile' || f.toLowerCase().includes('dockerfile'));
              if (subDockerfile) return path.join(entry.name, sub, subDockerfile);
            }
          } catch (e) { logDebug(e); }
        }
      } catch (e) { logDebug(e); }
    }
  } catch (e) { logDebug(e); }

  return null;
}

// Parses every top-level service block under `services:` in a compose file
// into { name, image, context, dependsOn }. This is a plain, general
// structural parse (not tied to any particular service name), so it can
// answer "what does service X depend on" for any service in the project -
// which the existing name-specific helpers above (findPortsInCompose etc.)
// can't do.
// Pulls the service names out of a compose service's depends_on block,
// accepting both the short list form ("- name") and the long map form
// ("name:" followed by an indented "condition:"). The block ends at the first
// line indented no deeper than depends_on itself.
function extractDependsOn(block) {
  const lines = block.split('\n');
  const deps = [];
  let blockIndent = null;

  for (const line of lines) {
    if (blockIndent === null) {
      const start = line.match(/^(\s*)depends_on:\s*(.*)$/);
      if (!start) continue;
      blockIndent = start[1].length;
      // Inline flow sequence: depends_on: [a, b]
      const inline = start[2].trim();
      if (inline.startsWith('[')) {
        for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
          const name = part.trim().replace(/^["']|["']$/g, '');
          if (/^[a-zA-Z0-9_.-]+$/.test(name)) deps.push(name);
        }
        break;
      }
      continue;
    }

    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= blockIndent) break; // dedented out of the depends_on block

    const listItem = line.match(/^\s*-\s*["']?([a-zA-Z0-9_.-]+)["']?\s*$/);
    if (listItem) { deps.push(listItem[1]); continue; }

    // Map form: only the direct children of depends_on are service names -
    // anything deeper is that entry's own "condition:"/"restart:" settings.
    const mapKey = line.match(/^(\s*)["']?([a-zA-Z0-9_.-]+)["']?:\s*$/);
    if (mapKey && mapKey[1].length === blockIndent + 2) deps.push(mapKey[2]);
  }
  return deps;
}

async function parseComposeServices(baseDir) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }

    const servicesMatch = content.match(/^services:\s*$/m);
    if (!servicesMatch) continue;
    const afterServices = content.slice(servicesMatch.index + servicesMatch[0].length);

    const firstServiceMatch = afterServices.match(/^([ \t]+)([a-zA-Z0-9_-]+):\s*$/m);
    if (!firstServiceMatch) continue;
    const indent = firstServiceMatch[1];

    const serviceBlockRegex = new RegExp('^' + indent + '([a-zA-Z0-9_-]+):\\s*$([\\s\\S]*?)(?=^' + indent + '[a-zA-Z0-9_-]+:\\s*$|(?![\\s\\S]))', 'gm');
    const services = {};
    let m;
    while ((m = serviceBlockRegex.exec(afterServices)) !== null) {
      const name = m[1];
      const block = m[2];
      const imageMatch = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
      const contextMatch = block.match(/context:\s*["']?([^\s"'#]+)["']?/) ||
        block.match(/build:\s*["']?(\.[^\s"'#{][^\s"'#]*)["']?\s*$/m);
      // depends_on has two spellings and only the short one was handled. The
      // long form -
      //   depends_on:
      //     order-postgres:
      //       condition: service_healthy
      // - is what any compose file using healthchecks writes, and it was
      // parsed as no dependencies at all. Everything keyed off depends_on
      // (which service owns which database, above all) silently saw an empty
      // graph for exactly the projects that describe themselves most
      // carefully. Read the block by indentation and accept both spellings.
      const dependsOn = extractDependsOn(block);
      services[name] = {
        name,
        image: imageMatch ? imageMatch[1] : null,
        context: contextMatch ? path.join(baseDir, contextMatch[1]) : null,
        dependsOn,
        block
      };
    }
    return services;
  }
  return {};
}

// A service's docker-compose `depends_on:` list is a direct, explicit
// statement of which other container it needs at runtime - when one of
// those dependencies is itself a known database image, that's a much
// stronger and more precise signal for "this specific service's database"
// than any generic env-var/compose-wide scan (which can only ever name ONE
// database for the whole project, no matter how many services and databases
// it actually contains).
async function analyzeServiceDatabaseFromCompose(baseDir, servicePath) {
  const services = await parseComposeServices(baseDir);
  const resolvedServicePath = path.resolve(servicePath);
  const owning = Object.values(services).find(s => s.context && path.resolve(s.context) === resolvedServicePath);
  if (!owning) return null;

  for (const depName of owning.dependsOn) {
    const dep = services[depName];
    if (!dep || !dep.image) continue;
    // composeServiceName lets the caller rewrite hostnames that point at this
    // exact compose service (e.g. "order-postgres") to the dedicated
    // StatefulSet generated for it, instead of to the shared "database".
    const dbType = composeImageDbType(dep.image);
    if (dbType) return { hasDb: true, dbType, port: DB_PORTS[dbType], image: dep.image, composeServiceName: depName };
  }
  return null;
}

// Spring Boot binds `spring.datasource.url`/`.username`/`.password` from the
// env vars SPRING_DATASOURCE_URL/_USERNAME/_PASSWORD automatically (its
// "relaxed binding" convention) - no source code change is needed to make it
// pick up a different database than whatever application.properties
// hardcodes. Detecting this lets Flarops wire a Spring service's own database
// purely through env vars, the same way it already relies on Django's/
// FastAPI's own conventions elsewhere.
// Does this YAML declare the given key path? Written by indentation rather
// than with a parser, because these files routinely contain "${VAR}"
// placeholders and profile separators a strict parser rejects. A dotted key
// ("spring.datasource.url: ...") carries its own path and is handled too.
function yamlHasKeyPath(content, wanted) {
  const stack = [];
  for (const rawLine of content.split('\n')) {
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue;
    const m = rawLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parts = [...stack.map(e => e.key), ...m[2].split('.')];
    if (parts.length >= wanted.length &&
        wanted.every((seg, i) => parts[parts.length - wanted.length + i].toLowerCase() === seg)) {
      return true;
    }
    if (m[3].trim() === '') stack.push({ indent, key: m[2] });
  }
  return false;
}

async function detectSpringDatasourceConfig(servicePath) {
  if (!servicePath) return false;
  try {
    await fs.access(path.join(servicePath, 'pom.xml'));
  } catch (e) {
    try {
      await fs.access(path.join(servicePath, 'build.gradle'));
    } catch (e2) {
      return false;
    }
  }

  const files = await walkDir(servicePath);
  for (const file of files) {
    const base = path.basename(file);
    if (!/^application(-\w+)?\.(properties|ya?ml)$/.test(base)) continue;
    try {
      const content = await fs.readFile(file, 'utf8');
      // Both spellings count. Only the flat one was recognised, so any Spring
      // service writing the ordinary nested YAML -
      //   spring:
      //     datasource:
      //       url: ...
      // - was treated as "not a Spring datasource service" and never had its
      // URL, username and password wired to the database Flarops generated
      // for it. The StatefulSet came up with a generated password while the
      // application went on authenticating with whatever the unresolved
      // placeholder held.
      if (/spring\.datasource\.url/.test(content)) return true;
      if (yamlHasKeyPath(content, ['spring', 'datasource', 'url'])) return true;
    } catch (e) { logDebug(e); }
  }
  return false;
}

// The Mongo counterpart of detectSpringDatasourceConfig. Spring Boot binds
// SPRING_DATA_MONGODB_URI from the environment by the same relaxed-binding
// convention, so a Mongo-backed service can be pointed at the database
// Flarops generated for it purely through env - but nothing looked for it,
// so those services kept whatever connection string docker-compose held:
// a container that no longer exists, with credentials that were never the
// ones the generated StatefulSet was initialised with.
async function detectSpringDataMongoConfig(servicePath) {
  if (!servicePath) return false;
  let isJava = true;
  try {
    await fs.access(path.join(servicePath, 'pom.xml'));
  } catch (e) {
    try {
      await fs.access(path.join(servicePath, 'build.gradle'));
    } catch (e2) {
      isJava = false;
    }
  }
  if (!isJava) return false;

  const files = await walkDir(servicePath);
  for (const file of files) {
    const base = path.basename(file);
    if (!/^application(-\w+)?\.(properties|ya?ml)$/.test(base)) continue;
    try {
      const content = await fs.readFile(file, 'utf8');
      if (/spring\.data\.mongodb\.(uri|host|database)/.test(content)) return true;
      if (yamlHasKeyPath(content, ['spring', 'data', 'mongodb'])) return true;
    } catch (e) { logDebug(e); }
  }
  return false;
}

async function analyzeDatabase(baseDir, backendPath) {
  let result = null;

  if (backendPath) {
    // Priority 1: ORM Configs
    const ormResult = await checkORM(baseDir, backendPath);
    if (ormResult) result = ormResult;

    // Priority 2: Package.json Dependencies
    if (!result) {
      const pkgResult = await checkPackageJson(backendPath);
      if (pkgResult) result = pkgResult;
    }

    // Priority 2.5: Python requirements.txt
    if (!result) {
      const reqResult = await checkRequirementsTxt(backendPath);
      if (reqResult) result = reqResult;
    }

    // Priority 2.55: every other ecosystem's dependency manifest (pyproject,
    // pom.xml, build.gradle, go.mod, Gemfile, composer.json, *.csproj).
    if (!result) {
      const manifestResult = await checkDependencyManifests(backendPath);
      if (manifestResult) result = manifestResult;
    }

    // Priority 2.6: docker-compose depends_on (see
    // analyzeServiceDatabaseFromCompose) - a precise, per-service signal,
    // checked before the generic/project-wide fallbacks below so it doesn't
    // get shadowed by whichever database happens to match first in those.
    if (!result) {
      const composeDepResult = await analyzeServiceDatabaseFromCompose(baseDir, backendPath);
      if (composeDepResult) result = composeDepResult;
    }
  }

  // Priority 3: Environment Variables (real .env)
  if (!result) {
    const envResult = await checkEnvVars(baseDir, backendPath, ['.env']);
    if (envResult) result = envResult;
  }

  // Priority 4: Environment Variables (fallback .env.example)
  if (!result) {
    const envExampleResult = await checkEnvVars(baseDir, backendPath, ['.env.example']);
    if (envExampleResult) result = envExampleResult;
  }

  // Priority 5: docker-compose.yml. Constrained by depends_on ownership (see
  // findComposeDatabaseCandidates): when every database in the compose file
  // already belongs to some other service, the project has no shared primary
  // database and inventing one from a stranger's store is worse than
  // reporting none - the services that own those databases each get their own
  // through analyzeServiceDatabaseFromCompose instead.
  let composeCandidates = null;
  if (!result) {
    composeCandidates = await findComposeDatabaseCandidates(baseDir, backendPath);
    if (composeCandidates && composeCandidates.dbServices.length > 0 && composeCandidates.available.length === 0) {
      return { hasDb: false };
    }
    if (composeCandidates && composeCandidates.available.length > 0) {
      const chosen = composeCandidates.available[0];
      const dbType = composeImageDbType(composeCandidates.services[chosen].image);
      result = {
        hasDb: true,
        dbType,
        port: DB_PORTS[dbType],
        image: composeCandidates.services[chosen].image,
        composeServiceName: chosen,
      };
    } else {
      const composeResult = await checkDockerCompose(baseDir);
      if (composeResult) result = composeResult;
    }
  }

  if (result) {
    // init.js needs to know WHICH compose service became the primary database,
    // so it can rewrite hostnames pointing at that one service (and only that
    // one) to the generated "database" Service.
    if (!result.composeServiceName) {
      const candidates = composeCandidates || await findComposeDatabaseCandidates(baseDir, backendPath);
      if (candidates) {
        const sameEngine = (candidates.available.length > 0 ? candidates.available : candidates.dbServices)
          .filter(n => composeImageDbType(candidates.services[n].image) === result.dbType);
        if (sameEngine.length === 1) result.composeServiceName = sameEngine[0];
        else if (sameEngine.length > 1 && candidates.backendService) {
          const owned = sameEngine.find(n => (candidates.ownersOf[n] || []).includes(candidates.backendService));
          if (owned) result.composeServiceName = owned;
        }
      }
    }

    const ownCreds = await extractCredentialsFromComposeService(baseDir, result.composeServiceName, result.dbType);
    const creds = await extractDbCredentials(baseDir, backendPath, result.dbType);
    // The owning service's own block wins; the project-wide scan only fills
    // in what that block did not state.
    result.dbUser = ownCreds.user || creds.user;
    result.dbName = ownCreds.name || creds.name;
    const pinnedImage = await findPinnedDbImageTag(baseDir, result.dbType);
    result.image = pinnedImage || await getLatestDbImage(result.dbType);
    
    const localDbDockerfile = await checkLocalDbDockerfile(baseDir);
    if (localDbDockerfile) {
      result.hasLocalDockerfile = true;
      result.localDbDockerfile = path.basename(localDbDockerfile);
      result.dbContext = path.dirname(localDbDockerfile);
    } else {
      result.hasLocalDockerfile = false;
    }
    
    return result;
  }

  // Fallback: No definitive markers found, assume no DB
  return { hasDb: false };
}

async function analyzeBackendForDbPasswordKey(backendPath) {
  if (!backendPath) return null;

  const passwordKeys = ['DB_PASS', 'DB_PASSWORD', 'DATABASE_PASSWORD', 'DATABASE_PASS', 'DB_SECRET', 'DB_ROOT_PASSWORD', 'POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD', 'POSTGRES_PASS', 'PG_PASSWORD', 'PGPASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'MYSQL_PASS', 'MARIADB_ROOT_PASSWORD', 'MARIADB_PASSWORD', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD', 'MONGO_PASS', 'MONGODB_PASSWORD', 'MONGO_ROOT_PASSWORD'];
  const regex = new RegExp('\\b(' + passwordKeys.join('|') + ')\\b', 'g');
  const counts = {};

  const files = await walkDir(backendPath);
  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf8');
      let match;
      while ((match = regex.exec(content)) !== null) {
        const key = match[1];
        counts[key] = (counts[key] || 0) + 1;
      }
    } catch (e) { logDebug(e); }
  }

  const sortedKeys = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sortedKeys.length > 0) {
    return sortedKeys[0][0]; // Return the most frequently used key
  }

  return null;
}

async function analyzeBackendForDbKeys(backendPath) {
  if (!backendPath) return { hostKey: null, userKey: null, nameKey: null, passwordKey: null, portKey: null };

  const hostCounts = {};
  const userCounts = {};
  const nameCounts = {};
  const passwordCounts = {};
  const portCounts = {};

  const files = await walkDir(backendPath);
  
  const envVarRegex = /(?:process\.env\.|process\.env\[['"`]|os\.Getenv\(['"`]|getenv\(['"`]|System\.getenv\(['"`]|Environment\.GetEnvironmentVariable\(['"`]|\$ENV\[['"`]|\$_ENV\[['"`])([a-zA-Z0-9_]+)/g;
  const destructureRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;

  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf8');
      
      // Names that belong to the SERVER this process runs, not to any database
      // it connects to. A bare PORT was being classified as the database port,
      // and init.js then overwrote it with 5432/3306/27017 - so the container
      // listened on the database's port while the Service, the probe and the
      // Ingress all pointed at the real one, and readiness never passed.
      const LISTEN_PORT_KEYS = /^(port|server_port|app_port|http_port|https_port|listen_port|web_port|service_port)$/;

      // The canonical per-engine names, which the generic patterns below miss
      // entirely: POSTGRES_USER does not contain "db_user", and POSTGRES_DB
      // does not match /^database$|^db$/. Both were silently unclassified, so
      // the API container was wired with a host, a port and a password but no
      // user and no database name.
      const ENGINE_USER_KEYS = /^(postgres_user|pguser|mysql_user|mariadb_user|mongo_initdb_root_username)$/;
      const ENGINE_NAME_KEYS = /^(postgres_db|pgdatabase|mysql_database|mariadb_database|mongo_initdb_database)$/;

      const processKey = (key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.match(/host|hostname/)) hostCounts[key] = (hostCounts[key] || 0) + 1;
        else if (ENGINE_USER_KEYS.test(lowerKey) || lowerKey.match(/^user$|username|db_user|dbuser/)) userCounts[key] = (userCounts[key] || 0) + 1;
        else if (ENGINE_NAME_KEYS.test(lowerKey) || lowerKey.match(/^database$|^db$|dbname|db_name|^name$/)) nameCounts[key] = (nameCounts[key] || 0) + 1;
        else if (lowerKey.match(/password|pass/)) passwordCounts[key] = (passwordCounts[key] || 0) + 1;
        else if (lowerKey.match(/port/) && !LISTEN_PORT_KEYS.test(lowerKey)) portCounts[key] = (portCounts[key] || 0) + 1;
      };

      let match;
      while ((match = envVarRegex.exec(content)) !== null) {
        processKey(match[1]);
      }

      // Spring (and anything else using the same placeholder syntax) reads its
      // database connection straight out of a config FILE - there is no
      // System.getenv call anywhere in the Java source for the scan above to
      // find. Without this, a Spring backend reported no database keys at all,
      // so nothing wired DB_HOST/DB_PORT/DB_NAME/DB_USER into its container:
      // the pod came up with a password and no address to use it against.
      //
      // Restricted to SCREAMING_SNAKE names so Spring's own property
      // references (${spring.datasource.url}) aren't mistaken for environment
      // variables.
      const base = path.basename(file);
      if (/^(application|bootstrap)(-[\w.]+)?\.(ya?ml|properties)$/.test(base)) {
        const springPlaceholderRegex = /\$\{\s*([A-Z][A-Z0-9_]*)\s*(?::[^}]*)?\}/g;
        let springMatch;
        while ((springMatch = springPlaceholderRegex.exec(content)) !== null) {
          processKey(springMatch[1]);
        }
      }

      let destructureMatch;
      while ((destructureMatch = destructureRegex.exec(content)) !== null) {
        const keys = destructureMatch[1].split(',').map(k => k.split(':')[0].split('=')[0].trim()).filter(k => k);
        for (const key of keys) {
          processKey(key);
        }
      }
    } catch (e) { logDebug(e); }
  }

  const getTopKey = (counts) => {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : null;
  };

  return {
    hostKey: getTopKey(hostCounts),
    userKey: getTopKey(userCounts),
    nameKey: getTopKey(nameCounts),
    passwordKey: getTopKey(passwordCounts),
    portKey: getTopKey(portCounts)
  };
}

module.exports = { analyzeDatabase, analyzeBackendForDbPasswordKey, analyzeBackendForDbKeys, analyzeServiceDatabaseFromCompose, detectSpringDatasourceConfig, detectSpringDataMongoConfig, findComposeDatabaseCandidates, composeImageDbType, parseComposeServices };
