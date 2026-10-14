const fs = require('fs');
const path = require('path');
const fsPromises = require('fs').promises;
const { walkDir, logDebug } = require('./fsHelper');

const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$/i;
const isTestFile = filePath => TEST_FILE_PATTERN.test(path.basename(filePath));

function injectVariableDeclaration(content, ext, envVarSyntax) {
  const declaration = `\nconst API_URL = ${envVarSyntax} || "";\n`;
  if (content.includes('const API_URL =')) return content;
  
  if (ext === '.vue' || ext === '.svelte') {
    return content.replace(/(<script[^>]*>)/i, `$1${declaration}`);
  } else {
    const lines = content.split('\n');
    let insertIndex = 0;
    let inMultilineImport = false;
    let inMultilineComment = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (inMultilineComment) {
        if (line.includes('*/')) inMultilineComment = false;
        insertIndex = i + 1;
        continue;
      }
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inMultilineComment = true;
        insertIndex = i + 1;
        continue;
      }
      
      if (inMultilineImport) {
        if (line.includes('from') && (line.includes("'") || line.includes('"'))) {
          inMultilineImport = false;
        }
        insertIndex = i + 1;
        continue;
      }
      
      if (line.startsWith('import ')) {
        if (!line.includes('from') || (!line.includes("'") && !line.includes('"'))) {
          if (!line.endsWith(";") && !line.endsWith("'") && !line.endsWith('"')) {
             inMultilineImport = true;
          }
        }
        insertIndex = i + 1;
        continue;
      }
      
      if (line.startsWith('require(') || line.startsWith('//') || line.startsWith("'use ") || line.startsWith('"use ') || line === '') {
        insertIndex = i + 1;
        continue;
      }
      
      break;
    }
    
    lines.splice(insertIndex, 0, declaration.trim());
    return lines.join('\n');
  }
}

// A variable the frontend already has is reused only when its name says it is the backend's address:
// NEXT_PUBLIC_SITE_URL, NEXTAUTH_URL or DATABASE_URL hold something else, which this would overwrite.
const BACKEND_URL_ENV_KEY = /^(?:(?:VITE|NEXT_PUBLIC|REACT_APP|VUE_APP|NUXT_PUBLIC|GATSBY|EXPO_PUBLIC|PUBLIC|NG)_)?(?:BACKEND_)?(?:API|BACKEND|SERVER)_?(?:BASE_)?UR[LI]$/;

// doModify false: work out the same changes, write nothing, and list the files they would touch.
async function refactorFrontendEnv(frontendDir, backendPorts, doModify = true) {
  if (!frontendDir || !backendPorts || backendPorts.length === 0) {
    return null;
  }

  let packageJson = {};
  try {
    const pkgPath = path.join(frontendDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      packageJson = JSON.parse(await fsPromises.readFile(pkgPath, 'utf8'));
    }
  } catch (e) { logDebug(e); }

  const allDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };

  // Angular's builder supports neither process.env nor import.meta.env, so URLs are made relative instead.
  const isAngular = !!(allDeps['@angular/core'] || allDeps['@angular-devkit/build-angular']);

  let envVarSyntax = 'process.env.API_URL';
  let envVarKey = 'API_URL';

  if (allDeps['vite'] || allDeps['svelte'] || allDeps['@sveltejs/kit']) {
    envVarSyntax = 'import.meta.env.VITE_API_URL';
    envVarKey = 'VITE_API_URL';
  } else if (allDeps['next']) {
    envVarSyntax = 'process.env.NEXT_PUBLIC_API_URL';
    envVarKey = 'NEXT_PUBLIC_API_URL';
  } else if (allDeps['nuxt']) {
    envVarSyntax = 'process.env.NUXT_PUBLIC_API_URL';
    envVarKey = 'NUXT_PUBLIC_API_URL';
  } else if (allDeps['@vue/cli-service']) {
    envVarSyntax = 'process.env.VUE_APP_API_URL';
    envVarKey = 'VUE_APP_API_URL';
  } else if (allDeps['react-scripts']) {
    envVarSyntax = 'process.env.REACT_APP_API_URL';
    envVarKey = 'REACT_APP_API_URL';
  } else if (allDeps['gatsby']) {
    envVarSyntax = 'process.env.GATSBY_API_URL';
    envVarKey = 'GATSBY_API_URL';
  } else if (allDeps['astro'] || allDeps['@builder.io/qwik']) {
    envVarSyntax = 'import.meta.env.PUBLIC_API_URL';
    envVarKey = 'PUBLIC_API_URL';
  }

  const filesToScan = await walkDir(frontendDir);
  let refactoredFilesCount = 0;
  const changedFiles = [];
  const supportFiles = [];
  let backendDetectedUrl = null;
  const discoveredRoutes = new Set();
  
  const existingEnvVars = {};
  for (const filePath of filesToScan) {
    if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(path.extname(filePath))) continue;
    let content = await fsPromises.readFile(filePath, 'utf8');
    
    const envRegex = /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]+)/g;
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      const key = match[1];
      if (BACKEND_URL_ENV_KEY.test(key)) {
        existingEnvVars[key] = (existingEnvVars[key] || 0) + 1;
      }
    }
  }
  
  if (Object.keys(existingEnvVars).length > 0) {
    const sorted = Object.entries(existingEnvVars).sort((a, b) => b[1] - a[1]);
    envVarKey = sorted[0][0];
    if (envVarKey.startsWith('VITE_') || envVarKey.startsWith('PUBLIC_')) {
      envVarSyntax = `import.meta.env.${envVarKey}`;
    } else {
      envVarSyntax = `process.env.${envVarKey}`;
    }
  }

  for (const filePath of filesToScan) {
    if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(path.extname(filePath))) continue;
    if (isTestFile(filePath)) continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;

    for (const port of backendPorts) {
      const regex = new RegExp(`(['"\`])(https?:\\/\\/[^\\/:\`"']+:${port})(.{0,100}?)\\1`, 'g');
      
      content = content.replace(regex, (match, quote, base, rest, offset, whole) => {
        // Already an env fallback ("process.env.X ?? 'http://...'"): rewriting it would make the variable
        // refer to itself.
        const before = whole.slice(Math.max(0, offset - 40), offset);
        if (/(\?\?|\|\|)\s*\(?\s*$/.test(before)) return match;

        modified = true;
        backendDetectedUrl = base; // Record what we found to use in .env.local

        if (rest) {
          const baseRoute = rest.split(/[\\?\\$]/)[0];
          if (baseRoute.startsWith('/')) {
            const topLevel = '/' + baseRoute.split('/')[1];
            if (topLevel && topLevel !== '/') {
              discoveredRoutes.add(topLevel);
            }
          }
        }

        if (isAngular) {
          return rest ? (quote + rest + quote) : (quote + quote);
        }

        if (!rest) {
          return 'API_URL';
        }

        if (quote === '\`') {
          return '`${API_URL}' + rest + '`';
        } else {
          return 'API_URL + ' + quote + rest + quote;
        }
      });
    }

    if (modified) {
      if (!isAngular) {
        content = injectVariableDeclaration(content, path.extname(filePath), envVarSyntax);
      }
      if (doModify) await fsPromises.writeFile(filePath, content, 'utf8');
      changedFiles.push(filePath);
      refactoredFilesCount++;
    }
  }

  if (!isAngular && refactoredFilesCount > 0 && backendDetectedUrl) {
    const envLocalPath = path.join(frontendDir, '.env.local');
    const envEntry = `${envVarKey}=${backendDetectedUrl}\n`;
    supportFiles.push(envLocalPath, path.join(frontendDir, '.dockerignore'), path.join(frontendDir, '.gitignore'));

    if (!doModify) {
      // Previewing: the files above are listed, nothing is written.
    } else if (fs.existsSync(envLocalPath)) {
      const existingEnv = await fsPromises.readFile(envLocalPath, 'utf8');
      if (!existingEnv.includes(`${envVarKey}=`)) {
        await fsPromises.appendFile(envLocalPath, `\n# Added by Flarops\n${envEntry}`);
      }
    } else {
      await fsPromises.writeFile(envLocalPath, `# Added by Flarops\n${envEntry}`);
    }

    const ignoreFiles = doModify ? ['.dockerignore', '.gitignore'] : [];
    for (const ignoreFile of ignoreFiles) {
      const ignorePath = path.join(frontendDir, ignoreFile);
      if (fs.existsSync(ignorePath)) {
        const content = await fsPromises.readFile(ignorePath, 'utf8');
        if (!content.includes('.env.local')) {
          await fsPromises.appendFile(ignorePath, `\n.env.local\n`);
        }
      } else {
        await fsPromises.writeFile(ignorePath, `.env.local\n`);
      }
    }
  }

  if (refactoredFilesCount > 0 || Object.keys(existingEnvVars).length > 0) {
    return {
      filesChanged: refactoredFilesCount,
      files: changedFiles,
      // .env.local (the local value) and the ignore files that keep it out of git and the image.
      supportFiles,
      envVarKey: envVarKey,
      discoveredRoutes: Array.from(discoveredRoutes)
    };
  }
  
  return null;
}

async function refactorBackendDbUrl(backendDir, doModify = false) {
  if (!backendDir) return null;
  const filesToScan = await walkDir(backendDir);
  const discoveredVars = new Set();
  let filesChanged = 0;
  let anyHardcoded = false;
  const hardcodedFiles = [];

  for (const filePath of filesToScan) {
    if (!['.js', '.ts'].includes(path.extname(filePath))) continue;
    if (isTestFile(filePath)) continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;
    let fileHasHardcoded = false;

    const envRegex = /process\.env\.([A-Z0-9_]*(?:DB|DATABASE|MONGO|POSTGRES|MYSQL)[A-Z0-9_]*(?:URL|URI|CONNECTION|STRING)?)/gi;
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      const key = match[1];
      if (key.match(/USER|USERNAME|PASSWORD|PASS|HOST|HOSTNAME|PORT|NAME|_DB$|^DB$|^DATABASE$|^DB_DATABASE$|DATABASE_DB|DB_NAME/i)) continue;
      discoveredVars.add(key);
    }

    const hardcodedRegex = /(['"`])((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb):\/\/[^'"`]+)\1/g;
    
    let hdMatch;
    while ((hdMatch = hardcodedRegex.exec(content)) !== null) {
      const before = content.slice(Math.max(0, hdMatch.index - 20), hdMatch.index);
      if (!before.match(/\|\|\s*$/) && !before.match(/process\.env\./)) {
        fileHasHardcoded = true;
        anyHardcoded = true;
        hardcodedFiles.push(filePath);
        break;
      }
    }
    
    hardcodedRegex.lastIndex = 0;

    if (fileHasHardcoded && doModify) {
      content = content.replace(hardcodedRegex, (m, quote, url, offset, string) => {
        const before = string.slice(Math.max(0, offset - 20), offset);
        if (before.match(/\|\|\s*$/) || before.match(/process\.env\./)) {
          return m;
        }
        modified = true;
        const newVar = url.startsWith('mongo') ? 'DB_URL' : 'DATABASE_URL';
        discoveredVars.add(newVar);
        return `(process.env.${newVar} || ${quote}${url}${quote})`;
      });
    }

    if (modified) {
      await fsPromises.writeFile(filePath, content, 'utf8');
      filesChanged++;
    }
  }

  return {
    filesChanged,
    files: hardcodedFiles,
    discoveredVars: Array.from(discoveredVars),
    hasHardcoded: anyHardcoded
  };
}

// The proxy_pass lines pointing at the backend's port, rewritten to the api Service. Returns the files
// changed (or, with doModify false, that would be).
async function refactorNginxConf(frontendDir, backendPorts, doModify = true) {
  if (!frontendDir || !backendPorts || backendPorts.length === 0) return [];
  const filesToScan = await walkDir(frontendDir);
  const changed = [];

  for (const filePath of filesToScan) {
    if (path.extname(filePath) !== '.conf') continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;

    for (const port of backendPorts) {
      const regex = new RegExp(`(proxy_pass\\s+https?:\\/\\/)([^\\/\\s:]+)(:${port})`, 'gi');
      content = content.replace(regex, (match, prefix, host, portStr) => {
        if (host.toLowerCase() !== 'api') {
          modified = true;
          return `${prefix}api${portStr}`;
        }
        return match;
      });
    }

    if (modified) {
      if (doModify) await fsPromises.writeFile(filePath, content, 'utf8');
      changed.push(filePath);
    }
  }
  return changed;
}

// Source files the upper-case rewrite edits; a key read anywhere else is not offered.
const LOWERCASE_REWRITE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.go', '.py', '.java', '.kt', '.php', '.cs', '.rb']);
const DOC_FILE = /\.(md|markdown|txt|rst|adoc)$/i;

// The calls that take the variable's name as a string: the ones analyzeBackendForDbKeys reads
// (utils/dbAnalyzer.js), and their siblings in the same languages.
const NAMED_READ_PREFIX = '(?:process\\.env\\[|os\\.Getenv\\(|os\\.LookupEnv\\(|getenv\\(|System\\.getenv\\(|Environment\\.GetEnvironmentVariable\\(|os\\.environ\\[|os\\.environ\\.get\\(|ENV\\[|ENV\\.fetch\\(|\\$ENV\\[|\\$_ENV\\[|\\$_SERVER\\[)';
// What analyzeBackendForDbKeys counts as a read, to find what the rewrite left behind.
const ANALYZER_READ = (key) => new RegExp(`(?:process\\.env\\.|(?:process\\.env\\[|os\\.Getenv\\(|getenv\\(|System\\.getenv\\(|Environment\\.GetEnvironmentVariable\\(|\\$ENV\\[|\\$_ENV\\[)['"\`])${escapeRegex(key)}(?![A-Za-z0-9_])`);
const DESTRUCTURE = /((?:const|let|var)\s*\{)([^}]+)(\}\s*=\s*process\.env\b)/g;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One key's reads in one file, upper-cased. Returns the new content and how many reads changed.
function rewriteKeyIn(content, key) {
  const upper = key.toUpperCase();
  const k = escapeRegex(key);
  let count = 0;
  let out = content.replace(new RegExp(`(${NAMED_READ_PREFIX}\\s*)(['"\`])${k}\\2`, 'g'), (m, prefix, quote) => {
    count++;
    return `${prefix}${quote}${upper}${quote}`;
  });
  out = out.replace(new RegExp(`(process\\.env\\.)${k}(?![A-Za-z0-9_$])`, 'g'), (m, prefix) => {
    count++;
    return prefix + upper;
  });
  // const { db_host } = process.env reads DB_HOST into the same local name: { DB_HOST: db_host }.
  out = out.replace(DESTRUCTURE, (m, open, body, close) => {
    const parts = body.split(',').map(part => {
      const p = part.match(/^(\s*)([A-Za-z_$][\w$]*)([\s\S]*)$/);
      if (!p || p[2] !== key) return part;
      count++;
      return /^\s*:/.test(p[3]) ? `${p[1]}${upper}${p[3]}` : `${p[1]}${upper}: ${key}${p[3]}`;
    });
    return open + parts.join(',') + close;
  });
  return { content: out, count };
}

// Whether a read of the key is left that the rewrite does not cover: a form it does not know, or the
// name as a string anywhere in the code (os.environ.get('db_host') in a helper, a config map).
function readLeftBehind(content, key, isCode) {
  if (ANALYZER_READ(key).test(content)) return true;
  DESTRUCTURE.lastIndex = 0;
  for (const m of content.matchAll(DESTRUCTURE)) {
    if (m[2].split(',').some(part => part.split(':')[0].split('=')[0].trim() === key)) return true;
  }
  return isCode && new RegExp(`(['"\`])${escapeRegex(key)}\\1`).test(content);
}

// Upper-cases the backend's reads of these lower-case variables. A key is rewritten only when every
// read of it can be (test files aside, as they are not deployed); rewrittenKeys says which were.
// doModify false: the same answer, nothing written.
async function refactorLowercaseEnvVars(backendDir, keysToUppercase, doModify = false) {
  const none = { modifiedCount: 0, files: [], rewrittenKeys: [], blockedKeys: [] };
  const keys = (keysToUppercase || []).filter(k => k && k !== k.toUpperCase());
  if (!backendDir || keys.length === 0) return none;

  const sources = [];
  for (const filePath of await walkDir(backendDir)) {
    if (isTestFile(filePath) || DOC_FILE.test(filePath)) continue;
    let content;
    try { content = await fsPromises.readFile(filePath, 'utf8'); } catch (e) { logDebug(e); continue; }
    sources.push({ filePath, content, isCode: LOWERCASE_REWRITE_EXTENSIONS.has(path.extname(filePath)) });
  }

  const rewritable = [];
  const blockedKeys = [];
  for (const key of keys) {
    let reads = 0;
    let blocked = false;
    for (const src of sources) {
      if (!src.isCode) {
        if (readLeftBehind(src.content, key, false)) blocked = true;
        continue;
      }
      const { content, count } = rewriteKeyIn(src.content, key);
      reads += count;
      if (readLeftBehind(content, key, true)) blocked = true;
    }
    if (blocked) blockedKeys.push(key);
    else if (reads > 0) rewritable.push(key);
  }

  const files = [];
  for (const src of sources) {
    if (!src.isCode) continue;
    let content = src.content;
    for (const key of rewritable) content = rewriteKeyIn(content, key).content;
    if (content === src.content) continue;
    if (doModify) await fsPromises.writeFile(src.filePath, content, 'utf8');
    files.push(src.filePath);
  }

  return { modifiedCount: files.length, files, rewrittenKeys: rewritable, blockedKeys };
}

module.exports = {
  refactorFrontendEnv,
  refactorBackendDbUrl,
  refactorNginxConf,
  refactorLowercaseEnvVars
};
