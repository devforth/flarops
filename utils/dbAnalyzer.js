const fs = require('fs').promises;
const path = require('path');
const https = require('https');

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
  let validTags = tags.filter(t => /^\\d+(\\.\\d+)*$/.test(t));
  
  if (dbType === 'postgres') {
    const alpineTags = tags.filter(t => /^\\d+(\\.\\d+)*-alpine$/.test(t));
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

const DB_PORTS = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  sqlite: 0
};

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
        } catch (e) {}
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
      } catch (e) {}

      const typeormFiles = ['ormconfig.json', 'typeorm.config.ts', 'typeorm.config.js'];
      for (const file of typeormFiles) {
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf8');
          if (testRegex(content, 'type\\s*[:=]\\s*["\']postgres["\']')) return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mysql["\']')) return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mariadb["\']')) return { hasDb: true, dbType: 'mariadb', port: DB_PORTS.mariadb };
          if (testRegex(content, 'type\\s*[:=]\\s*["\']mongodb["\']')) return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
        } catch (e) {}
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
  } catch (err) {}
  return null;
}

async function extractDbCredentials(baseDir, backendPath) {
  const filesToScan = [
    path.join(baseDir, '.env'),
    path.join(baseDir, '.env.example'),
    path.join(backendPath, '.env'),
    path.join(backendPath, '.env.example'),
    path.join(baseDir, 'docker-compose.yml'),
    path.join(baseDir, 'docker-compose.yaml'),
    path.join(baseDir, 'compose.yml'),
    path.join(baseDir, 'compose.yaml')
  ];

  let dbUser = null;
  let dbName = null;

  const userRegex = /^(?!\s*(?:#|\/\/))\s*(?:-\s*)?(?:DATABASE_USER|DB_USER|POSTGRES_USER|MYSQL_USER|MARIADB_USER|MONGO_INITDB_ROOT_USERNAME)\s*[:=]\s*["']?([^"'\s]+)["']?/im;
  const nameRegex = /^(?!\s*(?:#|\/\/))\s*(?:-\s*)?(?:DATABASE_DB|DB_NAME|DATABASE_NAME|POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE|MONGO_INITDB_DATABASE)\s*[:=]\s*["']?([^"'\s]+)["']?/im;

  for (const file of filesToScan) {
    try {
      const content = await fs.readFile(file, 'utf8');
      
      const urlMatch = content.match(/postgres(?:ql)?:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i) ||
                       content.match(/mysql:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i) ||
                       content.match(/mariadb:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i) ||
                       content.match(/mongodb(?:\+srv)?:\/\/([^:]+):[^@]*@[^\/]+\/([^?\s]+)/i);
      
      if (urlMatch && !dbUser && !dbName) {
        dbUser = urlMatch[1];
        dbName = urlMatch[2];
        if (dbUser && dbName) return { user: dbUser, name: dbName };
      }

      if (!dbUser) {
        const userMatch = content.match(userRegex);
        if (userMatch) dbUser = userMatch[1];
      }

      if (!dbName) {
        const nameMatch = content.match(nameRegex);
        if (nameMatch) dbName = nameMatch[1];
      }

      if (dbUser && dbName) {
         break;
      }
    } catch (e) {}
  }

  return { user: dbUser, name: dbName };
}

async function checkDockerCompose(baseDir) {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  for (const file of composeFiles) {
    try {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');
      if (testRegex(content, 'image:\\s*postgres') || testRegex(content, 'POSTGRES_USER') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?5432"?')) {
        return { hasDb: true, dbType: 'postgres', port: DB_PORTS.postgres };
      }
      if (testRegex(content, 'image:\\s*mysql') || testRegex(content, 'MYSQL_DATABASE') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?3306"?')) {
        return { hasDb: true, dbType: 'mysql', port: DB_PORTS.mysql };
      }
      if (testRegex(content, 'image:\\s*mongo') || testRegex(content, 'MONGO_URI') || testRegex(content, 'DB_PORT\\s*[:=]\\s*"?27017"?')) {
        return { hasDb: true, dbType: 'mongodb', port: DB_PORTS.mongodb };
      }
    } catch(e) {}
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
    } catch(e) {}
  }
  return null;
}

async function analyzeDatabase(baseDir, backendPath) {
  if (!backendPath) {
    return { hasDb: false };
  }

  let result = null;

  // Priority 1: ORM Configs
  const ormResult = await checkORM(baseDir, backendPath);
  if (ormResult) result = ormResult;

  // Priority 2: Package.json Dependencies
  if (!result) {
    const pkgResult = await checkPackageJson(backendPath);
    if (pkgResult) result = pkgResult;
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
    const creds = await extractDbCredentials(baseDir, backendPath);
    result.dbUser = creds.user;
    result.dbName = creds.name;
    result.image = await getLatestDbImage(result.dbType);
    
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

module.exports = { analyzeDatabase };
