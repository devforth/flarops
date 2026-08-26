const fs = require('fs');
const path = require('path');
const fsPromises = require('fs').promises;

// Re-using the same directory walker from routeAnalyzer
async function walkDir(dir, fileList = []) {
  const files = await fsPromises.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fsPromises.stat(filePath);
    if (stat.isDirectory()) {
      if (!['node_modules', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '.git'].includes(file)) {
        await walkDir(filePath, fileList);
      }
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

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

async function refactorFrontendEnv(frontendDir, backendPorts) {
  if (!frontendDir || !backendPorts || backendPorts.length === 0) {
    return null;
  }

  // 1. Determine Framework
  let packageJson = {};
  try {
    const pkgPath = path.join(frontendDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      packageJson = JSON.parse(await fsPromises.readFile(pkgPath, 'utf8'));
    }
  } catch (e) {}

  const allDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
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
  let backendDetectedUrl = null;
  const discoveredRoutes = new Set();
  
  // Try to find an existing API env var in the code
  const existingEnvVars = {};
  for (const filePath of filesToScan) {
    if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(path.extname(filePath))) continue;
    let content = await fsPromises.readFile(filePath, 'utf8');
    
    // Look for process.env.XXXXX or import.meta.env.XXXXX
    const envRegex = /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]+)/g;
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      const key = match[1];
      if (key.match(/^(NODE_ENV|PUBLIC_URL)$/)) continue;
      if (key.match(/API|URL|BASE/i)) {
        existingEnvVars[key] = (existingEnvVars[key] || 0) + 1;
      }
    }
  }
  
  if (Object.keys(existingEnvVars).length > 0) {
    // Sort by count
    const sorted = Object.entries(existingEnvVars).sort((a, b) => b[1] - a[1]);
    envVarKey = sorted[0][0];
    if (envVarSyntax.startsWith('import.meta.env.')) {
      envVarSyntax = `import.meta.env.${envVarKey}`;
    } else {
      envVarSyntax = `process.env.${envVarKey}`;
    }
  }

  for (const filePath of filesToScan) {
    if (!['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'].includes(path.extname(filePath))) continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;

    for (const port of backendPorts) {
      // Matches 'http://localhost:8000/some/path' or 'http://api.domain.com:8000/some/path'
      const regex = new RegExp(`(['"\`])(https?:\\/\\/[^\\/:\`"']+:${port})(.*?)\\1`, 'g');
      
      content = content.replace(regex, (match, quote, base, rest) => {
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
      content = injectVariableDeclaration(content, path.extname(filePath), envVarSyntax);
      await fsPromises.writeFile(filePath, content, 'utf8');
      refactoredFilesCount++;
    }
  }

  // 3. Create or update .env.local
  if (refactoredFilesCount > 0 && backendDetectedUrl) {
    const envLocalPath = path.join(frontendDir, '.env.local');
    const envEntry = `${envVarKey}=${backendDetectedUrl}\n`;
    
    if (fs.existsSync(envLocalPath)) {
      const existingEnv = await fsPromises.readFile(envLocalPath, 'utf8');
      if (!existingEnv.includes(`${envVarKey}=`)) {
        await fsPromises.appendFile(envLocalPath, `\n# Added by Flarops\n${envEntry}`);
      }
    } else {
      await fsPromises.writeFile(envLocalPath, `# Added by Flarops\n${envEntry}`);
    }

    // 4. Ensure .env.local is ignored in .dockerignore and .gitignore
    const ignoreFiles = ['.dockerignore', '.gitignore'];
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

  for (const filePath of filesToScan) {
    if (!['.js', '.ts'].includes(path.extname(filePath))) continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;
    let fileHasHardcoded = false;

    // Detect existing process.env variables (looking for anything DB related)
    const envRegex = /process\.env\.([A-Z0-9_]*(?:DB|DATABASE|MONGO|POSTGRES|MYSQL)[A-Z0-9_]*(?:URL|URI|CONNECTION|STRING)?)/gi;
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      const key = match[1];
      if (key.match(/USER|USERNAME|PASSWORD|PASS|HOST|HOSTNAME|PORT|NAME|_DB$|^DB$|^DATABASE$|^DB_DATABASE$|DATABASE_DB|DB_NAME/i)) continue;
      discoveredVars.add(key);
    }

    // Refactor hardcoded strings
    const hardcodedRegex = /(['"`])((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb):\/\/[^'"`]+)\1/g;
    
    let hdMatch;
    while ((hdMatch = hardcodedRegex.exec(content)) !== null) {
      const before = content.slice(Math.max(0, hdMatch.index - 20), hdMatch.index);
      if (!before.match(/\|\|\s*$/) && !before.match(/process\.env\./)) {
        fileHasHardcoded = true;
        anyHardcoded = true;
        break;
      }
    }
    
    // Reset regex lastIndex since we used it in a while loop
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
    discoveredVars: Array.from(discoveredVars),
    hasHardcoded: anyHardcoded
  };
}

async function refactorNginxConf(frontendDir, backendPorts) {
  if (!frontendDir || !backendPorts || backendPorts.length === 0) return null;
  const filesToScan = await walkDir(frontendDir);
  let filesChanged = 0;

  for (const filePath of filesToScan) {
    if (path.extname(filePath) !== '.conf') continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;

    for (const port of backendPorts) {
      // Matches proxy_pass http://kanban-app:8080/...
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
      await fsPromises.writeFile(filePath, content, 'utf8');
      filesChanged++;
    }
  }
  return filesChanged;
}

async function refactorLowercaseEnvVars(backendDir, keysToUppercase, doModify = false) {
  if (!backendDir || !keysToUppercase || keysToUppercase.length === 0) return { modifiedCount: 0 };
  
  const filesToScan = await walkDir(backendDir);
  let modifiedCount = 0;

  for (const filePath of filesToScan) {
    if (!['.js', '.ts', '.go', '.py', '.java', '.php', '.cs'].includes(path.extname(filePath))) continue;

    let content = await fsPromises.readFile(filePath, 'utf8');
    let modified = false;

    for (const key of keysToUppercase) {
      if (key === key.toUpperCase()) continue;
      
      const regex = new RegExp(`((?:process\\.env\\.|os\\.Getenv\\(['"\`]|getenv\\(['"\`]|System\\.getenv\\(['"\`]|Environment\\.GetEnvironmentVariable\\(['"\`]|\\$ENV\\[['"\`]|\\$_ENV\\[['"\`]))(${key})\\b`, 'g');
      
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (match[2] === key) {
          modified = true;
        }
      }
      
      if (modified) {
         content = content.replace(regex, (m, prefix, k) => {
           return prefix + k.toUpperCase();
         });
      }
    }

    if (modified && doModify) {
      await fsPromises.writeFile(filePath, content, 'utf8');
      modifiedCount++;
    } else if (modified) {
      modifiedCount++; // count files that would be modified
    }
  }
  
  return { modifiedCount };
}

module.exports = {
  refactorFrontendEnv,
  refactorBackendDbUrl,
  refactorNginxConf,
  refactorLowercaseEnvVars
};
