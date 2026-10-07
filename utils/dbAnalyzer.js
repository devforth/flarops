const fs = require('./textFs.js');
const path = require('path');
const { listComposeFiles } = require('./composeFiles');
const { walkDir, logDebug } = require('./fsHelper');
const { DB_PORTS, IGNORED_DIRS } = require('./constants');
const { defaultImageFor } = require('./dbDefaults');

// An image pinned in the project's own compose file wins over utils/dbDefaults.js: the code was
// written against that version.
async function findPinnedDbImageTag(baseDir, dbType) {
  const composeFiles = listComposeFiles(baseDir);
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

// Stand-in values from example files ("<database>", "changeme") are not configuration.
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

// Credentials from ONE compose database service's own block; extractDbCredentials scans the whole file.
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

  // Knowing the engine, match only its own variable names and URL scheme - a project can run several.
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

  // Character classes exclude whitespace so a match cannot run past the end of its line.
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

      // Commented-out lines (documentation) are not credentials.
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

function composeImageDbType(image) {
  if (!image) return null;
  const img = String(image).toLowerCase();
  if (/postgres/.test(img)) return 'postgres';
  if (/mariadb/.test(img)) return 'mariadb';
  if (/mysql/.test(img)) return 'mysql';
  if (/mongo/.test(img)) return 'mongodb';
  return null;
}

// Which compose database may be the project's shared "database": one the backend depends on, or
// one no other service owns.
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

  const backendOwned = dbServices.filter(d => backendService && (ownersOf[d] || []).includes(backendService));
  const unowned = dbServices.filter(d => (ownersOf[d] || []).length === 0);
  const available = backendOwned.length > 0 ? backendOwned : unowned;

  return { services, dbServices, available, backendService, ownersOf };
}

async function checkDockerCompose(baseDir) {
  const composeFiles = listComposeFiles(baseDir);
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

// Finds a Dockerfile that builds a database by what it is built FROM, wherever it sits.
async function findDbDockerfileByBaseImage(baseDir) {
  const dockerfileIn = async (dir) => {
    try {
      const files = await fs.readdir(dir);
      return files.find(f => f.toLowerCase() === 'dockerfile' || f.toLowerCase().startsWith('dockerfile.'));
    } catch (e) { return null; }
  };

  const candidates = [];
  try {
    for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      candidates.push(entry.name);
      try {
        for (const child of await fs.readdir(path.join(baseDir, entry.name), { withFileTypes: true })) {
          if (!child.isDirectory() || child.name.startsWith('.') || IGNORED_DIRS.has(child.name)) continue;
          candidates.push(path.join(entry.name, child.name));
        }
      } catch (e) { logDebug(e); }
    }
  } catch (e) { logDebug(e); }

  for (const rel of candidates) {
    const dir = path.join(baseDir, rel);
    const dockerfile = await dockerfileIn(dir);
    if (!dockerfile) continue;
    let content;
    try { content = await fs.readFile(path.join(dir, dockerfile), 'utf8'); } catch (e) { continue; }
    // Only the first FROM: later ones are build stages.
    const from = content.match(/^\s*FROM\s+([^\s]+)/im);
    if (!from) continue;
    const engine = composeImageDbType(from[1]);
    if (engine) return { dockerfile: path.join(rel, dockerfile), engine };
  }
  return null;
}

async function checkLocalDbDockerfile(baseDir) {
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

function extractDependsOn(block) {
  const lines = block.split('\n');
  const deps = [];
  let blockIndent = null;

  for (const line of lines) {
    if (blockIndent === null) {
      const start = line.match(/^(\s*)depends_on:\s*(.*)$/);
      if (!start) continue;
      blockIndent = start[1].length;
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

    const mapKey = line.match(/^(\s*)["']?([a-zA-Z0-9_.-]+)["']?:\s*$/);
    if (mapKey && mapKey[1].length === blockIndent + 2) deps.push(mapKey[2]);
  }
  return deps;
}

async function parseComposeServices(baseDir) {
  const composeFiles = listComposeFiles(baseDir);
  for (const file of composeFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(baseDir, file), 'utf8');
    } catch (e) { continue; }

    const servicesMatch = content.match(/^services:\s*$/m);
    if (!servicesMatch) continue;
    // Only the services: section - entries under networks: or volumes: are not services.
    const afterServices = (content.slice(servicesMatch.index + servicesMatch[0].length) + '\n').split(/\n(?=[^\s#])/)[0];

    const firstServiceMatch = afterServices.match(/^([ \t]+)([a-zA-Z0-9_-]+):\s*$/m);
    if (!firstServiceMatch) continue;
    const indent = firstServiceMatch[1];

    // A block ends at the next service or at the next top-level key (networks:, volumes:), whose
    // entries would otherwise be read as services and replace real ones of the same name.
    const serviceBlockRegex = new RegExp('^' + indent + '([a-zA-Z0-9_.-]+):\\s*$([\\s\\S]*?)(?=^' + indent + '[a-zA-Z0-9_.-]+:\\s*$|^\\S|(?![\\s\\S]))', 'gm');
    const services = {};
    let m;
    while ((m = serviceBlockRegex.exec(afterServices)) !== null) {
      const name = m[1];
      const block = m[2];
      const imageMatch = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
      const contextMatch = block.match(/context:\s*["']?([^\s"'#]+)["']?/) ||
        block.match(/build:\s*["']?(\.[^\s"'#{][^\s"'#]*)["']?\s*$/m);
      // depends_on in both the list and the long (condition:) form.
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

// depends_on naming a database image is a direct statement of which database a service uses.
async function analyzeServiceDatabaseFromCompose(baseDir, servicePath) {
  const services = await parseComposeServices(baseDir);
  const resolvedServicePath = path.resolve(servicePath);
  const owning = Object.values(services).find(s => s.context && path.resolve(s.context) === resolvedServicePath);
  if (!owning) return null;

  for (const depName of owning.dependsOn) {
    const dep = services[depName];
    if (!dep || !dep.image) continue;
    const dbType = composeImageDbType(dep.image);
    if (dbType) return { hasDb: true, dbType, port: DB_PORTS[dbType], image: dep.image, composeServiceName: depName };
  }
  return null;
}

// Spring binds SPRING_DATASOURCE_URL/_USERNAME/_PASSWORD from the environment by itself.
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
      // Both spellings: flat (spring.datasource.url) and nested YAML.
      if (/spring\.datasource\.url/.test(content)) return true;
      if (yamlHasKeyPath(content, ['spring', 'datasource', 'url'])) return true;
    } catch (e) { logDebug(e); }
  }
  return false;
}

// The Mongo counterpart: SPRING_DATA_MONGODB_URI.
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
    const ormResult = await checkORM(baseDir, backendPath);
    if (ormResult) result = ormResult;

    if (!result) {
      const pkgResult = await checkPackageJson(backendPath);
      if (pkgResult) result = pkgResult;
    }

    if (!result) {
      const reqResult = await checkRequirementsTxt(backendPath);
      if (reqResult) result = reqResult;
    }

    if (!result) {
      const manifestResult = await checkDependencyManifests(backendPath);
      if (manifestResult) result = manifestResult;
    }

    if (!result) {
      const composeDepResult = await analyzeServiceDatabaseFromCompose(baseDir, backendPath);
      if (composeDepResult) result = composeDepResult;
    }
  }

  if (!result) {
    const envResult = await checkEnvVars(baseDir, backendPath, ['.env']);
    if (envResult) result = envResult;
  }

  if (!result) {
    const envExampleResult = await checkEnvVars(baseDir, backendPath, ['.env.example']);
    if (envExampleResult) result = envExampleResult;
  }

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
    // A driver names a wire protocol, not a server (mysql2 talks to MariaDB too); the compose image decides.
    if (!result.image) {
      const forEngine = composeCandidates || await findComposeDatabaseCandidates(baseDir, backendPath);
      if (forEngine) {
        const engines = new Set(
          (forEngine.dbServices || [])
            .map(n => composeImageDbType(forEngine.services[n].image))
            .filter(Boolean)
        );
        if (engines.size === 1) {
          const declared = [...engines][0];
          if (declared !== result.dbType) {
            logDebug(`docker-compose declares ${declared}; overriding ${result.dbType} inferred from dependencies`);
            result.dbType = declared;
            result.port = DB_PORTS[declared];
          }
        }
      }
    }

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
    result.dbUser = ownCreds.user || creds.user;
    result.dbName = ownCreds.name || creds.name;
    const pinnedImage = await findPinnedDbImageTag(baseDir, result.dbType);
    // Only a tag the PROJECT pinned is reported as pinned.
    result.pinnedImage = pinnedImage || null;
    result.image = pinnedImage || defaultImageFor(result.dbType);
    
    const byBaseImage = await findDbDockerfileByBaseImage(baseDir);
    const localDbDockerfile = byBaseImage ? byBaseImage.dockerfile : await checkLocalDbDockerfile(baseDir);
    if (byBaseImage && byBaseImage.engine !== result.dbType) {
      logDebug(`${byBaseImage.dockerfile} builds ${byBaseImage.engine}; overriding ${result.dbType}`);
      result.dbType = byBaseImage.engine;
      result.port = DB_PORTS[byBaseImage.engine];
    }
    if (localDbDockerfile) {
      result.hasLocalDockerfile = true;
      result.localDbDockerfile = path.basename(localDbDockerfile);
      result.dbContext = path.dirname(localDbDockerfile);
    } else {
      result.hasLocalDockerfile = false;
    }
    
    return result;
  }

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
      
      // PORT and friends are the server's own listen port, not the database's.
      const LISTEN_PORT_KEYS = /^(port|server_port|app_port|http_port|https_port|listen_port|web_port|service_port)$/;

      // The engines' own variable names (POSTGRES_USER, POSTGRES_DB, ...) that the generic patterns miss.
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

      // Spring reads the connection from a config file via ${...} placeholders, not from getenv calls.
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
