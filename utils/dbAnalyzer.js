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

  const userRegex = new RegExp(`^(?!\\s*(?:#|\\/\\/))\\s*(?:-\\s*)?(?:${userKeys})\\s*[:=]\\s*["']?([^"'\\s#]+|[^"']+)["']?`, 'im');
  const nameRegex = new RegExp(`^(?!\\s*(?:#|\\/\\/))\\s*(?:-\\s*)?(?:${nameKeys})\\s*[:=]\\s*["']?([^"'\\s#]+|[^"']+)["']?`, 'im');

  const schemeRegexes = {
    postgres: /postgres(?:ql)?:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i,
    postgresql: /postgres(?:ql)?:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i,
    mysql: /mysql:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i,
    mariadb: /mariadb:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i,
    mongodb: /mongodb(?:\+srv)?:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i
  };

  for (const file of filesToScan) {
    try {
      const content = await fs.readFile(file, 'utf8');

      const urlMatch = dbType && schemeRegexes[dbType]
        ? content.match(schemeRegexes[dbType])
        : content.match(schemeRegexes.postgres) ||
          content.match(schemeRegexes.mysql) ||
          content.match(schemeRegexes.mariadb) ||
          content.match(schemeRegexes.mongodb);

      if (urlMatch && !dbUser && !dbName) {
        if (!/\$\{?/.test(urlMatch[1])) dbUser = urlMatch[1];
        if (!/\$\{?/.test(urlMatch[2])) dbName = urlMatch[2];
        if (dbUser && dbName) return { user: dbUser, name: dbName };
      }

      if (!dbUser) {
        const userMatch = content.match(userRegex);
        if (userMatch && !/\$\{?/.test(userMatch[1])) dbUser = userMatch[1].trim();
      }

      if (!dbName) {
        const nameMatch = content.match(nameRegex);
        if (nameMatch && !/\$\{?/.test(nameMatch[1])) dbName = nameMatch[1].trim();
      }

      if (dbUser && dbName) {
         break;
      }
    } catch (e) { logDebug(e); }
  }

  return { user: dbUser, name: dbName };
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
      const dependsOn = [];
      const dependsOnMatch = block.match(/depends_on:\s*\n((?:[ \t]*-[ \t]*[a-zA-Z0-9_-]+\s*\n?)+)/);
      if (dependsOnMatch) {
        const depRegex = /-\s*([a-zA-Z0-9_-]+)/g;
        let dm;
        while ((dm = depRegex.exec(dependsOnMatch[1])) !== null) dependsOn.push(dm[1]);
      }
      services[name] = {
        name,
        image: imageMatch ? imageMatch[1] : null,
        context: contextMatch ? path.join(baseDir, contextMatch[1]) : null,
        dependsOn
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
    const img = dep.image.toLowerCase();
    if (img.includes('postgres')) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres, image: dep.image };
    if (img.includes('mysql')) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql, image: dep.image };
    if (img.includes('mariadb')) return { hasDb: true, dbType: 'mariadb', port: DB_PORTS.mariadb, image: dep.image };
    if (img.includes('mongo')) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb, image: dep.image };
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
      if (/spring\.datasource\.url/.test(content)) return true;
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

  // Priority 5: docker-compose.yml
  if (!result) {
    const composeResult = await checkDockerCompose(baseDir);
    if (composeResult) result = composeResult;
  }

  if (result) {
    const creds = await extractDbCredentials(baseDir, backendPath, result.dbType);
    result.dbUser = creds.user;
    result.dbName = creds.name;
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
      
      const processKey = (key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.match(/host|hostname/)) hostCounts[key] = (hostCounts[key] || 0) + 1;
        else if (lowerKey.match(/^user$|username|db_user|dbuser/)) userCounts[key] = (userCounts[key] || 0) + 1;
        else if (lowerKey.match(/^database$|^db$|dbname|db_name|^name$/)) nameCounts[key] = (nameCounts[key] || 0) + 1;
        else if (lowerKey.match(/password|pass/)) passwordCounts[key] = (passwordCounts[key] || 0) + 1;
        else if (lowerKey.match(/port/)) portCounts[key] = (portCounts[key] || 0) + 1;
      };

      let match;
      while ((match = envVarRegex.exec(content)) !== null) {
        processKey(match[1]);
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

module.exports = { analyzeDatabase, analyzeBackendForDbPasswordKey, analyzeBackendForDbKeys, analyzeServiceDatabaseFromCompose, detectSpringDatasourceConfig };
