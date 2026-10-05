const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { getDefaultAWSCredentials, ensureAwsCli, handleS3Bucket } = require('../../utils/awsHelper.js');
const { SENSITIVE_REGEX, DB_PASSWORD_REGEX, IGNORED_DIRS, LOOPBACK_HOST_REGEX } = require('../../utils/constants.js');
const { parseSupportService, extractBuildArgs, extractCommand, extractEnvFiles, extractVolumes, materializeBindMounts } = require('../../utils/composeSupport.js');
const { generateFlaropsYaml } = require('../../utils/flaropsYaml.js');
const writeTerraform = require('../../templates/terraform.js');
const collectOperatorAnswers = require('./prompts.js');
const { defaultUserFor, passwordKeyFor, defaultImageFor, urlSchemeOf } = require('../../utils/dbDefaults.js');
const { yamlEscapeDoubleQuoted, generateEnvString } = require('../../utils/yamlWrite.js');
const { listComposeFiles, isVariantComposeFile, approveVariantComposeFile, composeBaseDir } = require('../../utils/composeFiles.js');
const { normalizeRoutes } = require('../../utils/routes.js');
const { EnvFile } = require('../../utils/envFile.js');
const { SecretWiring, unmountedSecretKeys } = require('../../utils/secretWiring.js');
const isYes = collectOperatorAnswers.isYes;
const hclEscapeString = writeTerraform.hclEscapeString;

// Path containment, not startsWith ("/repo/api" vs "/repo/api-docs").
function isPathInside(dirPath, targetPath) {
  if (!dirPath) return false;
  const rel = path.relative(dirPath, targetPath);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

function askPassword(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl._writeToOutput = function _writeToOutput(stringToWrite) {
    if (stringToWrite.includes(query)) {
      const queryIndex = stringToWrite.indexOf(query);
      const output = stringToWrite.slice(0, queryIndex + query.length);
      process.stdout.write(output);
    } else if (stringToWrite === '\r\n' || stringToWrite === '\n') {
      process.stdout.write('\n');
    }
  };

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

function ensureDir(dirPath, logMessage) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    if (logMessage) console.log(logMessage);
  }
}

function writeFileIfNotExists(filePath, content, logMessage, logIfExistsMessage) {
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8').trim() === '') {
    fs.writeFileSync(filePath, content);
    if (logMessage) console.log(logMessage);
  } else {
    if (logIfExistsMessage) console.log(logIfExistsMessage);
  }
}

const sensitiveRegex = SENSITIVE_REGEX;
const dbPasswordRegex = DB_PASSWORD_REGEX;

// Names that only point at an auth endpoint or toggle a protocol's auth are not credentials.
const NON_SENSITIVE_SUFFIX_REGEX = /(_(URI|URL|ENDPOINT|HOST|HOSTNAME|PATH|ADDRESS)|_(SMTP|IMAP|POP3|SSL|TLS|STARTTLS|HTTP|HTTPS|LDAP|SASL|PROXY)_AUTH)$/i;

// Frameworks inline these into the browser bundle: public by construction, and build-time.
const PUBLIC_CLIENT_ENV_PREFIX_REGEX = /^(VITE|NEXT_PUBLIC|REACT_APP|VUE_APP|NUXT_PUBLIC|GATSBY|EXPO_PUBLIC|PUBLIC|STORYBOOK)_/i;

function isSensitiveKey(key) {
  if (!sensitiveRegex.test(key)) return false;
  if (NON_SENSITIVE_SUFFIX_REGEX.test(key)) return false;
  if (PUBLIC_CLIENT_ENV_PREFIX_REGEX.test(key)) return false;
  return true;
}

const crypto = require('crypto');

// Example files are committed: their keys are real requirements, their values are public.
const EXAMPLE_ENV_FILE_REGEX = /^\.env\.(example|sample|template)$/;

// Values that only ever stand in for a secret.
const PLACEHOLDER_SECRET_REGEX = /^(?:changeme|change[-_ ]?(?:me|this|it)|todo|tbd|placeholder|secret|password|passwd|example|sample|dummy|x{3,}|\*+|\.{3}|<[^>]*>|your[-_ ].*|.*[-_ ]here)$|replace[-_]?me|change[-_]?me/i;

// Engine names and default superusers, as local compose setups use.
const WEAK_DB_PASSWORD_REGEX = /^(?:postgres|postgresql|root|admin|mysql|mariadb|mongo|mongodb|toor|12345678?|123456789|qwerty)$/i;

// Why a value must not become a production secret, or null. Decides the VALUE only - the key stays
// a secret and stays required.
function untrustedSecretValueReason(file, value, { isDbPassword = false, committed = false } = {}) {
  if (EXAMPLE_ENV_FILE_REGEX.test(path.basename(file))) return 'example file - committed, so the value is public';
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (committed && !/\$\{?[A-Za-z_]/.test(v)) return 'committed to git, so the value is public';
  if (PLACEHOLDER_SECRET_REGEX.test(v)) return 'placeholder value';
  if (isDbPassword && WEAK_DB_PASSWORD_REGEX.test(v)) return "the database engine's default password";
  return null;
}

const withheldSecretValues = [];

// A compose command that starts a development server.
const DEV_COMMAND_REGEX = /(^|\s)(--reload|--watch|nodemon|ts-node-dev|runserver|ng serve|next dev)(\s|$)|(^|\s)(npm|yarn|pnpm|bun)( run)? (dev|start:dev|watch)(\s|$)|^vite(\s+(?!build\b|preview\b)|$)/;

function looksLikeDevCommand(args) {
  return Array.isArray(args) && DEV_COMMAND_REGEX.test(args.join(' '));
}

// Whether the image starts something by itself (CMD or ENTRYPOINT).
function dockerfileDefinesCommand(contextDir, dockerfile) {
  if (!contextDir) return false;
  try {
    const text = fs.readFileSync(path.join(contextDir, dockerfile || 'Dockerfile'), 'utf8');
    return /^\s*(CMD|ENTRYPOINT)\b/im.test(text);
  } catch (e) {
    return false;
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const unresolvedPlaceholderKeys = new Set();

// Compose variables read into several settings: those settings must get the same value.
const placeholderVarToKeys = new Map();

function recordPlaceholderVars(value, key) {
  const varRegex = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = varRegex.exec(String(value))) !== null) {
    if (!placeholderVarToKeys.has(m[1])) placeholderVarToKeys.set(m[1], new Set());
    placeholderVarToKeys.get(m[1]).add(key);
  }
}

// A .env value as dotenv and env_file read it: "#" is a comment only unquoted and after whitespace.
function parseDotenvValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    for (let i = 1; i < text.length; i++) {
      if (quote === '"' && text[i] === '\\') { i++; continue; }
      if (text[i] === quote) return text.slice(1, i);
    }
  }
  return text.replace(/(^|\s+)#.*$/, '').trim();
}

// `parsed`: already read as a YAML scalar by extractEnv; do not parse it again.
function sanitizeEnvValue(val, key, { parsed = false } = {}) {
  let cleaned = parsed ? String(val == null ? '' : val) : parseDotenvValue(val);

  // An embedded ${VAR} cannot be resolved here; it is left visible and reported, never invented.
  const varRegex = /\$\{\{?([^}]+)\}\}?|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  if (varRegex.test(cleaned) && key) {
    unresolvedPlaceholderKeys.add(key);
    recordPlaceholderVars(cleaned, key);
  }
  return cleaned;
}

function extractBareVarRef(rawVal) {
  const trimmed = String(rawVal).trim();
  let inner;
  if (trimmed.startsWith('${') && trimmed.endsWith('}')) {
    inner = trimmed.slice(2, -1);
  } else if (/^\$[A-Za-z_]/.test(trimmed) && trimmed.indexOf('$', 1) === -1) {
    inner = trimmed.slice(1);
  } else {
    return null;
  }
  const m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(:-|:\?)?([\s\S]*)$/);
  if (!m) return null;
  // A non-empty default (${VAR:-value}) is a real value.
  if (m[2] === ':-' && m[3].trim() !== '') return null;
  return m[1];
}

// Is this service the project's own API gateway (by name or by a gateway dependency)?
const GATEWAY_NAME_REGEX = /(^|[-_])(api[-_]?)?(gateway|edge)([-_](service|server|api))?$|^bff([-_].*)?$/i;

// A payment or SMS gateway talks to a provider; it is not the edge.
const DOMAIN_GATEWAY_PREFIX_REGEX = /^(payment|pay|sms|email|mail|voice|telephony|fax|billing|card|bank|ussd|notification)[-_]/i;

const GATEWAY_DEPENDENCY_MARKERS = [
  { file: 'pom.xml', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'build.gradle', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'build.gradle.kts', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'package.json', pattern: /express-gateway|http-proxy-middleware|fastify-http-proxy|@nestjs\/microservices/i },
];

async function detectServiceIsGateway(servicePath, nameCandidates) {
  for (const candidate of nameCandidates) {
    if (!candidate) continue;
    const name = String(candidate);
    if (DOMAIN_GATEWAY_PREFIX_REGEX.test(name)) continue;
    if (GATEWAY_NAME_REGEX.test(name)) return true;
  }
  if (!servicePath) return false;
  for (const marker of GATEWAY_DEPENDENCY_MARKERS) {
    try {
      const content = fs.readFileSync(path.join(servicePath, marker.file), 'utf8');
      if (marker.pattern.test(content)) return true;
    } catch (e) { /* file doesn't exist here - not this marker */ }
  }
  return false;
}

// "KEY: ${KEY}" just forwards an outer variable: returns its default, or null when it has none.
function parseSelfReferentialPlaceholder(key, rawVal) {
  const trimmed = rawVal.trim();
  let inner;
  if (trimmed.startsWith('${') && trimmed.endsWith('}')) {
    inner = trimmed.slice(2, -1);
  } else if (/^\$[A-Za-z_]/.test(trimmed) && trimmed.indexOf('$', 1) === -1) {
    inner = trimmed.slice(1);
  } else {
    return undefined; // not a bare variable reference at all
  }

  const m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(:-|:\?)?([\s\S]*)$/);
  if (!m || m[1] !== key) return undefined; // references something else, or isn't self-referential

  if (m[2] === ':-' && m[3].trim() !== '') return m[3].trim();
  return null; // bare reference, or ":?", or ":-" with an empty default
}

// Decides a scanned variable's value and its bucket ('secret' or 'config'); the two are independent.
function classifyEnvVariable(key, rawVal, foundDbUrls) {
  if (foundDbUrls[key]) return null;
  if (dbPasswordRegex.test(key)) return null;

  const selfRef = parseSelfReferentialPlaceholder(key, rawVal);
  const value = selfRef !== undefined ? (selfRef || '') : sanitizeEnvValue(rawVal, key);

  return { key, value, disposition: isSensitiveKey(key) ? 'secret' : 'config' };
}

function applyEnvDecision(decision, targets) {
  const { key, value } = decision;
  const { isBackend, isFrontend, apiEnv, frontendEnv, sensitiveContext, matchedAdditionalServices } = targets;

  if (decision.disposition === 'secret') {
    // Dedup by key alone: the same secret is often declared in several places.
    const keyLine = new RegExp(`(^|\\n)${escapeRegex(key)}=([^\\n]*)`);
    const present = sensitiveContext.content.match(keyLine);
    if (!present) {
      sensitiveContext.content += `${key}=${value}\n`;
    } else if (present[2] === '' && value !== '') {
      // A blank (withheld) value is replaced by a real one found later.
      sensitiveContext.content = sensitiveContext.content.replace(keyLine, (m, lead) => `${lead}${key}=${value}`);
    }
    return;
  }

  if (isBackend) apiEnv[key] = value;
  if (isFrontend) frontendEnv[key] = value;
  for (const service of matchedAdditionalServices || []) {
    service.env[key] = value;
  }
}

module.exports = async function init() {
  const currentDir = process.cwd();
  const gitDir = path.join(currentDir, '.git');

  if (!fs.existsSync(gitDir)) {
    console.error("not a root of git repositoty");
    process.exit(1);
  }

  // init is one-shot: a second run would reissue keys and overwrite the user's edits.
  const flaropsYamlFile = path.join(currentDir, 'flarops.yaml');
  if (fs.existsSync(flaropsYamlFile)) {
    console.error("\x1b[31mflarops.yaml already exists - this project is already initialized.\x1b[0m");
    console.error("");
    console.error("  To change what is deployed, edit flarops.yaml.");
    console.error("  To drop chart templates that no longer match any service, run: flarops sync");
    console.error("  To generate everything again from scratch, delete flarops.yaml first.");
    console.error("  Note that a fresh init issues a new deploy key and dashboard password,");
    console.error("  and overwrites the generated chart, Terraform and workflows.");
    process.exit(1);
  }

  const gitignoreFile = path.join(currentDir, '.gitignore');
  const linesToIgnore = [
    '.env',
    '.keys/',
    'FLAROPS.md',
    '.terraform/',
    '*.tfstate',
    '*.tfstate.*',
    'crash.log',
    'crash.*.log',
    '*.tfvars',
    '*.tfvars.json',
    'override.tf',
    'override.tf.json',
    '*_override.tf',
    '*_override.tf.json',
    '*tfplan*',
    // .terraform.lock.hcl is deliberately not ignored.
    'deploy/helm/flarops-ci-values.json'
  ];

  if (!fs.existsSync(gitignoreFile)) {
    fs.writeFileSync(gitignoreFile, '#autogenerated by flarops\n' + linesToIgnore.join('\n') + '\n');
    console.log("Created .gitignore and added ignore rules");
  } else {
    const gitignoreContent = fs.readFileSync(gitignoreFile, 'utf8');
    const existingLines = new Set(gitignoreContent.split('\n').map(line => line.trim()));
    const linesToAdd = linesToIgnore.filter(line => !existingLines.has(line));

    if (linesToAdd.length > 0) {
      let appendStr = '#autogenerated by flarops\n' + linesToAdd.join('\n') + '\n';
      if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
        appendStr = '\n' + appendStr;
      }
      fs.appendFileSync(gitignoreFile, appendStr);
      console.log(`Appended ${linesToAdd.length} rules to .gitignore`);
    } else {
      console.log("All ignore rules are already in .gitignore");
    }
  }

  const keysDir = path.join(currentDir, '.keys');
  ensureDir(keysDir, "Created .keys/ directory");

  const privateKeyPath = path.join(keysDir, 'deploy_rsa');
  const publicKeyPath = path.join(keysDir, 'deploy_rsa.pub');

  // The deploy key is reused (the instance trusts it), but never one tracked by git.
  const isTrackedByGit = (filePath) => {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', filePath], { cwd: currentDir, stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  };

  const committedFiles = new Map();
  const isCommitted = (filePath) => {
    if (!filePath) return false;
    if (!committedFiles.has(filePath)) committedFiles.set(filePath, isTrackedByGit(filePath));
    return committedFiles.get(filePath);
  };

  const usableSecretValue = (key, value, sourceFile) => {
    const reason = sourceFile ? untrustedSecretValueReason(sourceFile, value, { committed: isCommitted(sourceFile) }) : null;
    if (!reason || value === '' || value == null) return value;
    withheldSecretValues.push(`${key} (${path.relative(currentDir, sourceFile)}: ${reason})`);
    return '';
  };

  const takeEnvVariable = (key, val, sourceFile, targets) => {
    const decision = classifyEnvVariable(key, val, targets.foundDbUrls);
    if (decision && decision.disposition === 'secret') decision.value = usableSecretValue(key, decision.value, sourceFile);
    if (decision) applyEnvDecision(decision, targets);
    return decision;
  };

  if (fs.existsSync(privateKeyPath) && isTrackedByGit(privateKeyPath)) {
    console.error(`\x1b[31mERROR: ${path.relative(currentDir, privateKeyPath)} is committed to this repository.\x1b[0m`);
    console.error("A deploy key in git history is readable by everyone with access to the repo (and by anyone at all if it is public), so it cannot be used to provision infrastructure.");
    console.error("Remove it from tracking and let Flarops generate a fresh one:");
    console.error("  git rm --cached .keys/deploy_rsa .keys/deploy_rsa.pub");
    console.error("  rm .keys/deploy_rsa .keys/deploy_rsa.pub");
    console.error("Then purge it from history (git filter-repo / BFG) and rotate it anywhere it was authorized.");
    process.exit(1);
  }

  if (fs.existsSync(privateKeyPath)) {
    // A mismatched pair would authorize a key nobody holds.
    let pairIsConsistent = false;
    try {
      const derivedPublic = execFileSync('ssh-keygen', ['-y', '-f', privateKeyPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      const storedPublic = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8').trim() : '';
      pairIsConsistent = storedPublic.startsWith(derivedPublic.split(' ').slice(0, 2).join(' '));
    } catch (e) {
      pairIsConsistent = false;
    }

    if (!pairIsConsistent) {
      console.warn("\x1b[33mWARNING: .keys/deploy_rsa and .keys/deploy_rsa.pub are not a matching pair (or the private key is unreadable). Generating a fresh key.\x1b[0m");
      try { fs.unlinkSync(privateKeyPath); } catch (e) { }
      try { fs.unlinkSync(publicKeyPath); } catch (e) { }
    }
  }

  if (!fs.existsSync(privateKeyPath)) {
    console.log("Generating SSH keys in .keys/ ...");
    execFileSync('ssh-keygen', ['-t', 'rsa', '-b', '4096', '-f', privateKeyPath, '-q', '-N', '']);
  }

  try { fs.chmodSync(keysDir, 0o700); } catch (e) { }
  try { fs.chmodSync(privateKeyPath, 0o600); } catch (e) { }

  const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8').trim();

  console.log("\nConfigure your state");

  const answers = await collectOperatorAnswers({
    currentDir, askQuestion, askPassword, execFileSync,
    ensureAwsCli, handleS3Bucket, getDefaultAWSCredentials,
  });
  const {
    projectName, dockerRegistry, dockerProject, dockerRepository, registryUser, registryPassword,
    domain, cloudflareApiToken, cloudflareZoneId,
    awsCredentials, awsRegion, remoteStateBucket,
  } = answers;
  let s3BucketWarning = answers.s3BucketWarning;

  const deployDir = path.join(currentDir, 'deploy');
  const terraformDir = path.join(deployDir, 'terraform');

  ensureDir(deployDir, "Created deploy/ directory");
  ensureDir(terraformDir, "Created deploy/terraform/ directory");
  writeTerraform({
    projectName, domain, publicKey, awsRegion, remoteStateBucket, terraformDir,
    cloudflareApiToken, cloudflareZoneId, writeFileIfNotExists,
  });

  const ignoredDirs = new Set([...IGNORED_DIRS, '.git']);

  // Real .env files first, then example files (their keys still count).
  const ENV_FILE_PRECEDENCE = ['.env', '.env.local', '.env.production', '.env.development', '.env.example', '.env.sample', '.env.template'];

  function findEnvFiles(dir, fileList = []) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) { return fileList; }

    for (const file of files) {
      if (ignoredDirs.has(file)) continue;
      const fullPath = path.join(dir, file);
      try {
        // Symlinks are skipped: nothing outside the repository is read.
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          findEnvFiles(fullPath, fileList);
        } else if (ENV_FILE_PRECEDENCE.includes(file)) {
          fileList.push(fullPath);
        }
      } catch (e) { }
    }
    return fileList;
  }

  const { analyzeBackend, analyzeFrontend, analyzeAdditionalServices, extractUsedEnvVars, detectApiMigrationStep, detectApiWorkerCount, findRoutePortMapFromGatewayConfig, rootContextExcludes } = require('../../utils/analyzer');
  const { analyzeDatabase, analyzeBackendForDbPasswordKey, analyzeBackendForDbKeys, detectSpringDatasourceConfig, detectSpringDataMongoConfig, analyzeServiceDatabaseFromCompose, composeImageDbType, parseComposeServices } = require('../../utils/dbAnalyzer');
  const { analyzeFrontendRoutes } = require('../../utils/routeAnalyzer');
  const { refactorFrontendEnv, refactorBackendDbUrl, refactorNginxConf, refactorLowercaseEnvVars } = require('../../utils/envRefactor');

  // A non-conventionally named compose file is often a local stack; ask before using it.
  {
    const candidates = listComposeFiles(currentDir);
    if (candidates.length > 0 && isVariantComposeFile(candidates[0])) {
      const answer = await askQuestion(`\x1b[36m? \x1b[0mThis project has no docker-compose.yml, but it does have "${candidates[0]}". Base the deployment on it? [Y/n] `);
      const approved = isYes(answer);
      approveVariantComposeFile(approved);
      if (!approved) {
        console.log(`\x1b[33mSkipping ${candidates[0]}. Services will be discovered from the repository layout alone - anything only that file declares will be missing, and can be added to flarops.yaml afterwards.\x1b[0m`);
      }
    }
  }

  const backendInfo = await analyzeBackend(currentDir);
  const [frontendInfo, dbInfo] = await Promise.all([
    analyzeFrontend(currentDir, backendInfo.backendPath),
    analyzeDatabase(currentDir, backendInfo.backendPath)
  ]);

  let knownPaths = [];
  // A root-context service would otherwise read every sibling service's env as its own.
  const rootExcludes = await rootContextExcludes(currentDir, [backendInfo.backendPath, frontendInfo.frontendPath]);
  const excludesFor = (servicePath) =>
    (servicePath && path.resolve(servicePath) === path.resolve(currentDir)) ? rootExcludes : [];

  if (backendInfo.backendPath) {
    knownPaths.push(backendInfo.backendPath);
    backendInfo.usedEnvVars = await extractUsedEnvVars(backendInfo.backendPath, excludesFor(backendInfo.backendPath));
  }
  if (frontendInfo.frontendPath) {
    knownPaths.push(frontendInfo.frontendPath);
    frontendInfo.usedEnvVars = await extractUsedEnvVars(frontendInfo.frontendPath, excludesFor(frontendInfo.frontendPath));
  }

  // A database built from this repository is claimed, so it is not deployed a second time as a service.
  if (dbInfo.hasDb && dbInfo.hasLocalDockerfile && dbInfo.dbContext) {
    knownPaths.push(path.join(currentDir, dbInfo.dbContext));
    // An image the repository builds for its database wins over one compose pins.
    if (dbInfo.pinnedImage) {
      console.log(`\x1b[34mINFO: docker-compose pins ${dbInfo.pinnedImage} for the database, but ${path.join(dbInfo.dbContext, dbInfo.localDbDockerfile || 'Dockerfile')} builds one in this repository - building that instead. Its credentials and database name still come from the compose declaration.\x1b[0m`);
    }
  }

  // Compose keys already generated as backend/frontend; other services on the same context are separate.
  const claimedComposeNames = new Set();
  try {
    const { findBuildableComposeServices } = require('../../utils/analyzer');
    const builds = await findBuildableComposeServices(currentDir);
    for (const [composeName, info] of Object.entries(builds)) {
      for (const claimedPath of knownPaths.filter(Boolean)) {
        if (path.resolve(info.context) === path.resolve(claimedPath)) {
          if (!claimedComposeNames.size || claimedComposeNames.has(composeName)) claimedComposeNames.add(composeName);
          else if (![...claimedComposeNames].some(n => builds[n] && path.resolve(builds[n].context) === path.resolve(info.context))) claimedComposeNames.add(composeName);
          break;
        }
      }
    }
  } catch (e) { /* no compose - nothing is claimed by key */ }

  // A build context outside the repository cannot be built; say which ones.
  try {
    const { findBuildableComposeServices } = require('../../utils/analyzer');
    const builds = await findBuildableComposeServices(currentDir);
    const escaped = [];
    for (const [composeName, info] of Object.entries(builds)) {
      const resolved = path.resolve(info.context);
      const inside = resolved === path.resolve(currentDir)
        || resolved.startsWith(path.resolve(currentDir) + path.sep);
      if (!inside) escaped.push(`${composeName} (context: ${path.relative(currentDir, resolved) || info.context})`);
    }
    if (escaped.length > 0) {
      console.warn(`\x1b[33mWARNING: ${escaped.length} docker-compose service(s) build from a context OUTSIDE this repository and were skipped: ${escaped.join(', ')}. A compose file meant to sit one directory down ("context: ../api") does this to every service at once. Fix the paths so they are relative to the repository root, or declare those services in flarops.yaml and run "flarops sync".\x1b[0m`);
      console.log("");
    }
  } catch (e) { /* best effort */ }

  if (dbInfo.hasDb && dbInfo.composeServiceName) claimedComposeNames.add(dbInfo.composeServiceName);

  let additionalServices = await analyzeAdditionalServices(currentDir, knownPaths, claimedComposeNames);

  const usedNames = new Set(['api', 'frontend', 'db', 'database', 'dashboard']);
  for (const s of additionalServices) {
    let baseName = s.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    let finalName = baseName;
    let counter = 1;
    while (usedNames.has(finalName)) {
      finalName = `${baseName}-${counter}`;
      counter++;
    }
    s.name = finalName;
    usedNames.add(finalName);
  }

  let refactoredEnvKey = null;
  let refactoredRoutes = [];
  if (frontendInfo.frontendPath && backendInfo.ports && backendInfo.ports.length > 0) {
    const doRefactor = await askQuestion('\x1b[36m? \x1b[0mDo you want to automatically refactor hardcoded frontend API URLs to environment variables? [Y/n] ');
    if (isYes(doRefactor)) {
      const refactorResult = await refactorFrontendEnv(frontendInfo.frontendPath, backendInfo.ports);
      const nginxRefactorCount = await refactorNginxConf(frontendInfo.frontendPath, backendInfo.ports);
      if (nginxRefactorCount > 0) {
        console.log(`\x1b[32mSuccessfully refactored ${nginxRefactorCount} Nginx config files to point to the correct Kubernetes backend service.\x1b[0m`);
      }
      if (refactorResult) {
        refactoredEnvKey = refactorResult.envVarKey;
        if (refactorResult.discoveredRoutes) {
          refactoredRoutes = refactorResult.discoveredRoutes;
        }
        if (refactorResult.filesChanged > 0) {
          console.log(`\x1b[32mSuccessfully refactored ${refactorResult.filesChanged} files to use ${refactoredEnvKey}.\x1b[0m`);
        }
      }
    }
  }

  let foundDbUrls = {};

  if (backendInfo.backendPath && dbInfo.hasDb) {
    let dbRefactorResult = await refactorBackendDbUrl(backendInfo.backendPath, false);

    if (dbRefactorResult && dbRefactorResult.hasHardcoded) {
      const doDbRefactor = await askQuestion('\x1b[36m? \x1b[0mDo you want to automatically refactor hardcoded database URLs in the backend to environment variables? [Y/n] ');
      if (isYes(doDbRefactor)) {
        dbRefactorResult = await refactorBackendDbUrl(backendInfo.backendPath, true);
        if (dbRefactorResult && dbRefactorResult.filesChanged > 0) {
          console.log(`\x1b[32mSuccessfully refactored ${dbRefactorResult.filesChanged} backend files to use ${dbRefactorResult.discoveredVars.join(', ')}.\x1b[0m`);
        }
      }
    }

    if (dbRefactorResult && dbRefactorResult.discoveredVars.length > 0) {
      for (const dbVar of dbRefactorResult.discoveredVars) {
        foundDbUrls[dbVar] = { key: dbVar, query: '' };
      }
    }
  }

  const dbUrlKeyRegex = /^(DATABASE_URL|DB_URL|MONGO_URI|MONGO_URL|POSTGRES_URL|MYSQL_URL)$/;
  const CREDENTIAL_OWNER_ENV_KEYS = new Set([
    'POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD',
    'MONGO_INITDB_ROOT_PASSWORD', 'RABBITMQ_DEFAULT_PASS', 'KC_BOOTSTRAP_ADMIN_PASSWORD',
  ]);

  // Read before the .env scan: shared-credential discovery needs it.
  const composeFiles = listComposeFiles(currentDir);
  let composeContent = null;
  // Paths inside a compose file resolve against its own directory.
  let composeDir = currentDir;
  let composeFilePath = null;
  for (const cf of composeFiles) {
    try {
      composeContent = fs.readFileSync(path.join(currentDir, cf), 'utf8');
      composeFilePath = path.join(currentDir, cf);
      composeDir = composeBaseDir(currentDir, cf);
      if (isVariantComposeFile(cf)) {
        console.log(`\x1b[34mINFO: reading ${cf} as this project's docker-compose file - it is the only one here.\x1b[0m`);
      }
      break;
    } catch (e) { /* not this name - try the next */ }
  }

  // One canonical Secret key per shared credential (see utils/secretWiring.js). Must exist before the
  // .env scan, which calls tryWireSharedCredential.
  const wiring = new SecretWiring();
  const sharedCredentialSecrets = wiring.credentials;
  // Secret keys forced by compose declarations, which a source scan cannot see (Spring's relaxed binding).
  const apiForcedSecretKeys = wiring.api.forcedKeys;
  const frontendForcedSecretKeys = wiring.frontend.forcedKeys;
  const apiExtraSecretEnvMappings = wiring.api.mappings;
  const frontendExtraSecretEnvMappings = wiring.frontend.mappings;

  const registerSharedCredential = (varName, secretKeyName) => wiring.registerCredential(varName, secretKeyName);

  // Every credential owner is registered before any consumer is scanned: compose order is arbitrary.
  let composeServicesForCredentials = {};
  async function discoverSharedCredentials() {
    if (!composeContent) return;
    const composeServicesAll = await parseComposeServices(currentDir);
    composeServicesForCredentials = composeServicesAll;
    for (const svc of Object.values(composeServicesAll)) {
      if (!svc.block) continue;
      for (const ownerKey of CREDENTIAL_OWNER_ENV_KEYS) {
        const m = svc.block.match(new RegExp(`^\\s*${ownerKey}:\\s*(.+)$`, 'm'));
        if (!m) continue;
        const bareVar = extractBareVarRef(m[1]);
        if (bareVar) registerSharedCredential(bareVar, ownerKey);
      }
      // Redis sets its password via --requirepass, not an env var.
      const cmdMatch = svc.block.match(/--requirepass["',\s]*\$\{?([A-Za-z_][A-Za-z0-9_]*)/);
      if (cmdMatch) registerSharedCredential(cmdMatch[1], cmdMatch[1]);
    }
  }
  await discoverSharedCredentials();

  // A sensitive key whose value is a bare reference to a shared credential is wired to it directly.
  function tryWireSharedCredential(key, rawVal, isBackend, isFrontend, matchedAdditionalServices) {
    if (!isSensitiveKey(key)) return false;
    const bareVar = extractBareVarRef(rawVal);
    if (!bareVar || !sharedCredentialSecrets.has(bareVar)) return false;
    const { secretKey } = sharedCredentialSecrets.get(bareVar);

    if (isBackend) wiring.wire(wiring.api, key, secretKey);
    if (isFrontend) wiring.wire(wiring.frontend, key, secretKey);
    for (const s of matchedAdditionalServices || []) wiring.wire(s, key, secretKey);
    return true;
  }

  // Within a directory a real .env beats an example file; across directories nothing is deduped.
  const envFiles = findEnvFiles(currentDir).sort((a, b) => {
    const dirCmp = path.dirname(a).localeCompare(path.dirname(b));
    if (dirCmp !== 0) return dirCmp;
    return ENV_FILE_PRECEDENCE.indexOf(path.basename(a)) - ENV_FILE_PRECEDENCE.indexOf(path.basename(b));
  });
  const keysSeenPerDir = new Map();
  let foundDbPasswords = [];

  let apiEnv = {};
  let frontendEnv = {};
  let apiCommand = null;
  let apiBuildArgs = null;
  let frontendBuildArgs = null;
  let frontendCommand = null;
  let sensitiveEnvContent = '';

  for (const file of envFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const isRoot = file === path.join(currentDir, '.env');

    let isBackend = false;
    let isFrontend = false;
    let matchedAdditionalServices = [];

    for (const s of additionalServices) {
      if (isPathInside(s.path, file) || isRoot) {
        matchedAdditionalServices.push(s);
      }
    }

    if (backendInfo.backendPath && isPathInside(backendInfo.backendPath, file)) {
      isBackend = true;
    } else if (frontendInfo.frontendPath && isPathInside(frontendInfo.frontendPath, file)) {
      isFrontend = true;
    } else if (isRoot) {
      isBackend = true;
      isFrontend = true;
    }

    const passwordRegex = /^(?:export\s+)?(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)\s*=\s*(.*)$/gm;
    let match;
    while ((match = passwordRegex.exec(content)) !== null) {
      const key = match[1];
      const val = parseDotenvValue(match[2]);
      if (val) {
        foundDbPasswords.push({
          file: path.relative(currentDir, file) || '.env', key, value: val,
          untrusted: untrustedSecretValueReason(file, val, { isDbPassword: true, committed: isCommitted(file) }),
        });
      }
    }

    const urlRegex = /^(?:export\s+)?(DATABASE_URL|DB_URL|MONGO_URI|MONGO_URL|POSTGRES_URL|MYSQL_URL)\s*=\s*(.*)$/gm;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(content)) !== null) {
      const key = urlMatch[1];
      const val = parseDotenvValue(urlMatch[2]);
      if (val && !foundDbUrls[key]) {
        let query = '';
        try {
          const tempVal = val.replace(/\${([^}]+)}/g, 'BASH_VAR_$1');
          const urlObj = new URL(tempVal);
          query = urlObj.search || '';
        } catch (e) { }
        foundDbUrls[key] = { key, query, scheme: urlSchemeOf(val) };
      }
    }

    const dirKey = path.dirname(file);
    if (!keysSeenPerDir.has(dirKey)) keysSeenPerDir.set(dirKey, new Set());
    const seenInDir = keysSeenPerDir.get(dirKey);

    const lines = content.split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
      if (lineMatch) {
        const key = lineMatch[1];
        const val = lineMatch[2];

        // A lower-precedence file in the same directory does not override.
        if (seenInDir.has(key)) continue;
        seenInDir.add(key);

        const handledServices = typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : [];
        if (!tryWireSharedCredential(key, val, isBackend, isFrontend, handledServices)) {
          let sensitiveContext = { content: sensitiveEnvContent };
          takeEnvVariable(key, val, file, {
            isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv,
            sensitiveContext, matchedAdditionalServices: handledServices,
          });
          sensitiveEnvContent = sensitiveContext.content;
        }
      }
    }
  }

  if (refactoredEnvKey) {
    frontendEnv[refactoredEnvKey] = '';
  }

  // Infrastructure services' own credentials are generated here, and every consumer of the same
  // compose variable is wired to that one secret.

  // compose service key -> generated k8s Service name, for rewriting hostnames in values.
  const composeNameToK8s = {};
  // container_name -> compose key: containers are reachable by either name.
  const composeContainerNames = new Map();
  // Compose database services, resolved to generated names once ownership is known.
  const composeDbServiceNames = new Set();
  // Image-only compose services, kept to generate the ones the application references.
  const composeSupportCandidates = new Map();

  const envFileWarnings = [];
  const droppedDevCommands = [];
  if (composeContent) {
    const composeBlocks = await parseComposeServices(currentDir);
    const services = Object.keys(composeBlocks).map(name => ({ name }));

    for (let i = 0; i < services.length; i++) {
      const block = composeBlocks[services[i].name].block;

      // A build context (active or commented out) is an alternate identity for matching directories.
      const buildDirMatch = block.match(/^\s*#?\s*build:\s*\.?\/?([a-zA-Z0-9_-]+)\s*$/m) || block.match(/^\s*#?\s*context:\s*\.?\/?([a-zA-Z0-9_-]+)\s*$/m);
      const buildDirName = buildDirMatch ? buildDirMatch[1] : null;

      // "context: .": the repo root, which is the backend when the backend is the root.
      const buildsFromRoot = /^\s*#?\s*(?:build|context):\s*\.\/?\s*$/m.test(block);

      const containerNameMatch = block.match(/^\s*container_name:\s*["']?([a-zA-Z0-9_.-]+)["']?\s*$/m);
      if (containerNameMatch) composeContainerNames.set(containerNameMatch[1], services[i].name);

      const backendIsRoot = backendInfo.backendPath && path.resolve(backendInfo.backendPath) === path.resolve(currentDir);
      const frontendIsRoot = frontendInfo.frontendPath && path.resolve(frontendInfo.frontendPath) === path.resolve(currentDir);
      let isBackend = ['api', 'backend', 'server'].includes(services[i].name) || (buildsFromRoot && backendIsRoot) || (backendInfo.backendPath && (path.basename(backendInfo.backendPath) === services[i].name || (buildDirName && path.basename(backendInfo.backendPath) === buildDirName)));
      let isFrontend = ['frontend', 'client', 'ui', 'web'].includes(services[i].name) || (buildsFromRoot && frontendIsRoot && !isBackend) || (frontendInfo.frontendPath && (path.basename(frontendInfo.frontendPath) === services[i].name || (buildDirName && path.basename(frontendInfo.frontendPath) === buildDirName)));
      const sanitizeServiceName = (n) => String(n).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const composeKey = services[i].name;
      let matchedAdditionalServices = additionalServices.filter(s =>
        s.name === composeKey ||
        s.originalName === composeKey ||
        s.name === sanitizeServiceName(composeKey) ||
        (buildDirName && (s.name === buildDirName || s.originalName === buildDirName || s.name === sanitizeServiceName(buildDirName)))
      );

      // A compose service generated as an additional service of its own is that service, even on the
      // backend's directory (a worker beside the API).
      if (additionalServices.some(s => s.composeName === composeKey)) {
        isBackend = false;
        isFrontend = false;
      }

      if (isBackend) composeNameToK8s[services[i].name] = 'api';
      else if (isFrontend) composeNameToK8s[services[i].name] = 'frontend';
      else if (matchedAdditionalServices.length > 0) composeNameToK8s[services[i].name] = matchedAdditionalServices[0].name;
      else {
        // Not an app service. Which database object it maps to is decided after the database wiring below.
        const imageMatch = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
        const img = imageMatch ? imageMatch[1] : '';
        if (composeImageDbType(img)) composeDbServiceNames.add(services[i].name);

        // "profiles:" makes a service opt-in; those are never generated.
        if (img && !/^\s*profiles:/m.test(block)) {
          composeSupportCandidates.set(services[i].name, block);
        }
      }

      if (!isBackend && !isFrontend && matchedAdditionalServices.length === 0) continue;

      // Named volumes on a built service are its own persistence; bind mounts are not carried (on an app
      // service they are usually the source tree).
      if (matchedAdditionalServices.length > 0 && !isBackend && !isFrontend) {
        const { persistent } = extractVolumes(block);
        for (const s of matchedAdditionalServices) {
          if (persistent.length > 0 && (!s.volumes || s.volumes.length === 0)) s.volumes = persistent.map(v => ({ ...v }));
        }
      }

      {
        const buildArgs = extractBuildArgs(block);
        if (buildArgs) {
          if (isBackend) apiBuildArgs = { ...(apiBuildArgs || {}), ...buildArgs };
          if (isFrontend) frontendBuildArgs = { ...(frontendBuildArgs || {}), ...buildArgs };
          for (const s of matchedAdditionalServices) {
            s.buildArgs = { ...(s.buildArgs || {}), ...buildArgs };
          }
        }
      }

      // compose `command:` - some apps take all their configuration as CLI arguments.
      {
        const commandArgs = extractCommand(block) || [];
        if (commandArgs.length > 0) {
          // A shared credential in an argument becomes k8s $(VAR) interpolation.
          for (let i = 0; i < commandArgs.length; i++) {
            const bareVar = extractBareVarRef(commandArgs[i]);
            if (!bareVar || !sharedCredentialSecrets.has(bareVar)) continue;
            const { secretKey } = sharedCredentialSecrets.get(bareVar);
            commandArgs[i] = `$(${secretKey})`;
            if (isBackend) apiForcedSecretKeys.add(secretKey);
            if (isFrontend) frontendForcedSecretKeys.add(secretKey);
            for (const s of matchedAdditionalServices) {
              s.forcedSecretKeys.add(secretKey);
            }
          }
          // A dev-server command would replace the image's CMD (which may run migrations); when the image has
          // one, it wins.
          const devOnly = looksLikeDevCommand(commandArgs);
          const carry = (label, contextDir, dockerfile) => {
            if (!devOnly) return true;
            if (!dockerfileDefinesCommand(contextDir, dockerfile)) return true;
            droppedDevCommands.push(`${label}: "${commandArgs.join(' ')}"`);
            return false;
          };
          if (isBackend && !apiCommand && carry('api', backendInfo.backendPath, backendInfo.dockerfile)) apiCommand = commandArgs;
          if (isFrontend && !frontendCommand && carry('frontend', frontendInfo.frontendPath, frontendInfo.dockerfile)) frontendCommand = commandArgs;
          for (const s of matchedAdditionalServices) {
            if (!s.command && carry(s.name, s.path, s.dockerfile)) s.command = commandArgs;
          }
        }
      }

      const lines = block.split('\n');
      let inEnv = false;
      let envIndent = 0;
      // environment: wins over env_file, as in compose.
      const declaredInEnvironment = new Set();

      for (const line of lines) {
        if (!inEnv) {
          const m = line.match(/^([ \t]+)environment:\s*$/);
          if (m) {
            inEnv = true;
            envIndent = m[1].length;
          }
        } else {
          if (line.trim() === '') continue;
          const indentMatch = line.match(/^([ \t]*)/);
          const lineIndent = indentMatch ? indentMatch[1].length : 0;

          if (lineIndent <= envIndent) {
            if (lineIndent === envIndent && line.trim().startsWith('-')) {
            } else {
              inEnv = false;
              break; // exit environment block
            }
          }

          const envLineMatch = line.match(/^[ \t]+(?:-\s+)?([A-Z_][A-Z0-9_]*)\s*[:=]\s*(.*)$/);
          if (envLineMatch) {
            const key = envLineMatch[1];
            const val = envLineMatch[2];
            declaredInEnvironment.add(key);

            // A DB URL declared in compose is rebuilt against the real Service name by the chart.
            if (dbUrlKeyRegex.test(key) && !foundDbUrls[key]) {
              const cleanedVal = parseDotenvValue(val);
              let query = '';
              try {
                const tempVal = cleanedVal.replace(/\$\{([^}]+)\}/g, 'BASH_VAR_$1');
                const urlObj = new URL(tempVal);
                query = urlObj.search || '';
              } catch (e) { }
              foundDbUrls[key] = { key, query, scheme: urlSchemeOf(cleanedVal) };
            }

            // Each additional service may name its own database on a shared server.
            if (dbUrlKeyRegex.test(key) && typeof matchedAdditionalServices !== 'undefined' && matchedAdditionalServices.length > 0) {
              const cleanedVal = parseDotenvValue(val);
              let ownDbName = null;
              try {
                const tempVal = cleanedVal.replace(/\$\{([^}]+)\}/g, 'BASH_VAR_$1');
                const urlObj = new URL(tempVal);
                ownDbName = urlObj.pathname ? urlObj.pathname.replace(/^\//, '') : null;
              } catch (e) { }
              for (const s of matchedAdditionalServices) {
                if (!s.dbUrlVars.some(v => v.key === key)) {
                  s.dbUrlVars.push({ key, dbName: ownDbName, scheme: urlSchemeOf(cleanedVal) });
                }
              }
            }

            const handledServices = typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : [];
            if (!tryWireSharedCredential(key, val, isBackend, isFrontend, handledServices)) {
              let sensitiveContext = { content: sensitiveEnvContent };
              takeEnvVariable(key, val, composeFilePath, {
                isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv,
                sensitiveContext, matchedAdditionalServices: handledServices,
              });
              sensitiveEnvContent = sensitiveContext.content;

              // A sensitive key compose declares for this service is wired even if the source never spells it out.
              if (isSensitiveKey(key)) {
                if (isBackend) apiForcedSecretKeys.add(key);
                if (isFrontend) frontendForcedSecretKeys.add(key);
                for (const s of handledServices) {
                  s.forcedSecretKeys.add(key);
                }
              }
            }
          }
        }
      }

      // env_file: read with the same rules as environment:, after it.
      for (const envFileEntry of extractEnvFiles(block)) {
        const envFilePath = path.resolve(composeDir, envFileEntry.path);
        const shown = path.relative(currentDir, envFilePath) || envFileEntry.path;
        let envFileStat = null;
        try { envFileStat = fs.lstatSync(envFilePath); } catch (e) { /* missing */ }
        if (!isPathInside(currentDir, envFilePath) || (envFileStat && envFileStat.isSymbolicLink())) {
          envFileWarnings.push(`${composeKey}: ${shown} (outside this repository, or a symlink - not read)`);
          continue;
        }
        if (!envFileStat || !envFileStat.isFile()) {
          if (envFileEntry.required) envFileWarnings.push(`${composeKey}: ${shown} (does not exist)`);
          continue;
        }
        const handledServices = matchedAdditionalServices;
        for (const line of fs.readFileSync(envFilePath, 'utf8').split('\n')) {
          const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
          if (!m || declaredInEnvironment.has(m[1])) continue;
          const [, key, val] = m;
          if (dbPasswordRegex.test(key)) {
            const value = parseDotenvValue(val);
            if (value) {
              foundDbPasswords.push({
                file: shown, key, value,
                untrusted: untrustedSecretValueReason(envFilePath, value, { isDbPassword: true, committed: isCommitted(envFilePath) }),
              });
            }
            continue;
          }
          if (tryWireSharedCredential(key, val, isBackend, isFrontend, handledServices)) continue;
          const sensitiveContext = { content: sensitiveEnvContent };
          takeEnvVariable(key, val, envFilePath, {
            isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv,
            sensitiveContext, matchedAdditionalServices: handledServices,
          });
          sensitiveEnvContent = sensitiveContext.content;
          if (isSensitiveKey(key)) {
            if (isBackend) apiForcedSecretKeys.add(key);
            if (isFrontend) frontendForcedSecretKeys.add(key);
            for (const s of handledServices) s.forcedSecretKeys.add(key);
          }
        }
      }
    }
  }
  if (droppedDevCommands.length > 0) {
    console.warn(`\x1b[33mWARNING: These docker-compose commands start a development server, so they were NOT carried into the cluster - each image's own CMD runs instead: ${droppedDevCommands.join('; ')}. If production needs a command of its own, set it under the service's command in flarops.yaml and run "flarops sync".\x1b[0m`);
  }
  if (envFileWarnings.length > 0) {
    console.warn(`\x1b[33mWARNING: These env_file entries in docker-compose could not be read, so their variables are missing from the deployment: ${envFileWarnings.join('; ')}. Add the variables to flarops.yaml (or the file to the repository) and run "flarops sync".\x1b[0m`);
  }

  // Rewriting compose hostnames waits for the database wiring, which decides what each maps to.
  const resolveComposeDatabaseNames = () => {
    if (dbInfo.hasDb && dbInfo.composeServiceName && composeDbServiceNames.has(dbInfo.composeServiceName)) {
      composeNameToK8s[dbInfo.composeServiceName] = 'database';
    }
    for (const s of additionalServices) {
      if (!s.db || !s.db.composeServiceName) continue;
      if (!composeDbServiceNames.has(s.db.composeServiceName)) continue;
      composeNameToK8s[s.db.composeServiceName] = s.db.shared ? 'database' : `${s.name}-db`;
    }
  };

  // A compose name used as a hostname, not as part of a longer word ("worker.js").
  const composeHostnameRegex = (composeName) =>
    new RegExp('(?<![A-Za-z0-9_.-])' + escapeRegex(composeName) + '(?![A-Za-z0-9_.-])', 'g');

  // Compose hostnames in values become the generated Service names.
  const rewriteComposeHostnamesIn = (envObj) => {
    const composeNamesFound = Object.keys(composeNameToK8s);
    if (composeNamesFound.length === 0) return;
    for (const k of Object.keys(envObj)) {
      let val = String(envObj[k]);
      let changed = false;
      for (const composeName of composeNamesFound) {
        const k8sName = composeNameToK8s[composeName];
        if (composeName === k8sName) continue;
        const re = composeHostnameRegex(composeName);
        const newVal = val.replace(re, k8sName);
        if (newVal !== val) {
          val = newVal;
          changed = true;
        }
      }
      if (changed) envObj[k] = val;
    }
  };

  const rewriteComposeHostnamesInList = (list) => {
    if (!Array.isArray(list)) return list;
    const composeNamesFound = Object.keys(composeNameToK8s);
    if (composeNamesFound.length === 0) return list;
    return list.map(item => {
      let val = String(item);
      for (const composeName of composeNamesFound) {
        const k8sName = composeNameToK8s[composeName];
        if (composeName === k8sName) continue;
        const re = composeHostnameRegex(composeName);
        val = val.replace(re, k8sName);
      }
      return val;
    });
  };

  const rewriteComposeHostnames = () => {
    rewriteComposeHostnamesIn(apiEnv);
    rewriteComposeHostnamesIn(frontendEnv);
    for (const s of additionalServices) rewriteComposeHostnamesIn(s.env);
    if (apiCommand) apiCommand = rewriteComposeHostnamesInList(apiCommand);
    if (frontendCommand) frontendCommand = rewriteComposeHostnamesInList(frontendCommand);
    for (const s of additionalServices) {
      if (s.command) s.command = rewriteComposeHostnamesInList(s.command);
    }
  };

  if (dbInfo.hasDb) {
    let defaultDbPort = 3306;
    if (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql') defaultDbPort = 5432;
    else if (dbInfo.dbType === 'mongodb') defaultDbPort = 27017;
    else if (dbInfo.dbType === 'redis') defaultDbPort = 6379;

    // A *_HOST key is the database only when its name or value says so.
    const dbRelatedKeyName = /(^|_)(DB|DATABASE|MONGO|MONGODB|MYSQL|POSTGRES|POSTGRESQL|MARIADB|PG)_/i;
    const dbRelatedValue = /(db|database|mysql|postgres|mariadb|mongo|localhost|127\.0\.0\.1)/i;

    const PRIMARY_ENGINE_WORDS = {
      postgres: ['postgres', 'postgresql', 'pgsql', 'pg'],
      postgresql: ['postgres', 'postgresql', 'pgsql', 'pg'],
      mysql: ['mysql'],
      mariadb: ['mariadb', 'mysql'],
      mongodb: ['mongo', 'mongodb'],
      redis: ['redis', 'valkey'],
    };

    // Other datastores (Redis, brokers, search) have host variables spelled like a database's.
    const OTHER_DATASTORE_REGEX = /(redis|valkey|memcache|rabbit|amqp|kafka|zookeeper|pulsar|nats|elastic|opensearch|solr|clickhouse|cassandra|scylla|influx|neo4j|etcd|consul|vault|minio|smtp|mail|keycloak|sonar|grafana|prometheus|loki|tempo|jaeger|sentry)/i;

    const primaryWords = PRIMARY_ENGINE_WORDS[String(dbInfo.dbType || '').toLowerCase()] || [];
    const namesPrimaryEngine = (text) => primaryWords.some(w => new RegExp(w, 'i').test(text));

    const normalizeDbHost = (envObj) => {
      const hostKeys = Object.keys(envObj).filter(k => /(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i.test(k));
      if (hostKeys.length === 0) return;

      let dbPrefix = null;
      for (const k of hostKeys) {
        const val = String(envObj[k]).toLowerCase();
        const combined = `${k} ${val}`;
        if (OTHER_DATASTORE_REGEX.test(combined) && !namesPrimaryEngine(combined)) continue;
        if (!dbRelatedKeyName.test(k) && !dbRelatedValue.test(val)) continue;
        if (!dbPrefix) dbPrefix = k.replace(/(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i, '');
        envObj[k] = 'database';
      }
      if (!dbPrefix) return; // none of this env's *_HOST keys actually referenced the database

      const portKey = `${dbPrefix}_PORT`;
      if (!envObj[portKey] || isNaN(envObj[portKey])) {
        envObj[portKey] = String(defaultDbPort);
      }
    };

    // The api always gets a DATABASE_PORT default.
    if (!Object.keys(apiEnv).some(k => /(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i.test(k))) {
      if (!apiEnv.DATABASE_PORT || isNaN(apiEnv.DATABASE_PORT)) apiEnv.DATABASE_PORT = String(defaultDbPort);
    }
    normalizeDbHost(apiEnv);
    for (const s of additionalServices) {
      normalizeDbHost(s.env);
    }
  }

  const defaultDbPortForApi = dbInfo.dbType === 'mongodb' ? 27017 : (dbInfo.dbType === 'mysql' || dbInfo.dbType === 'mariadb' ? 3306 : 5432);
  let inferredKeys = null;
  if (dbInfo.hasDb && backendInfo.hasBackend) {
    inferredKeys = await analyzeBackendForDbKeys(backendInfo.backendPath);

    const keysToUppercase = [];
    ['hostKey', 'userKey', 'nameKey', 'passwordKey', 'portKey'].forEach(k => {
      const val = inferredKeys[k];
      if (val && val !== val.toUpperCase() && !keysToUppercase.includes(val)) {
        keysToUppercase.push(val);
      }
    });

    if (keysToUppercase.length > 0) {
      const confirmAnswer = await askQuestion(`\x1b[36m? \x1b[0mFound lowercase environment variables in backend code (${keysToUppercase.join(', ')}). Standard convention is UPPERCASE. Do you want to automatically refactor them? [Y/n] `);
      const didUppercase = isYes(confirmAnswer);

      if (didUppercase) {
        const { modifiedCount } = await refactorLowercaseEnvVars(backendInfo.backendPath, keysToUppercase, true);
        if (modifiedCount > 0) {
          console.log(`\x1b[34mINFO: Refactored lowercase environment variables to uppercase in ${modifiedCount} backend files.\x1b[0m`);
        }

        ['hostKey', 'userKey', 'nameKey', 'passwordKey', 'portKey'].forEach(k => {
          if (inferredKeys[k]) inferredKeys[k] = inferredKeys[k].toUpperCase();
        });
      }
    }
    if (inferredKeys.hostKey && !apiEnv[inferredKeys.hostKey]) {
      apiEnv[inferredKeys.hostKey] = 'database';
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database host key: ${inferredKeys.hostKey}\x1b[0m`);
    }
    if (inferredKeys.userKey && !apiEnv[inferredKeys.userKey]) {
      apiEnv[inferredKeys.userKey] = dbInfo.dbUser || defaultUserFor(dbInfo.dbType);
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database user key: ${inferredKeys.userKey}\x1b[0m`);
    }
    if (inferredKeys.nameKey && !apiEnv[inferredKeys.nameKey]) {
      apiEnv[inferredKeys.nameKey] = dbInfo.dbName || 'appdb';
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database name key: ${inferredKeys.nameKey}\x1b[0m`);
    }
    // Wire the port key the backend actually reads, and drop the generic DATABASE_PORT then.
    if (inferredKeys.portKey && !apiEnv[inferredKeys.portKey]) {
      apiEnv[inferredKeys.portKey] = String(dbInfo.port || defaultDbPortForApi);
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database port key: ${inferredKeys.portKey}\x1b[0m`);
    }
    if (inferredKeys.portKey && inferredKeys.portKey !== 'DATABASE_PORT') {
      delete apiEnv.DATABASE_PORT;
    }
  }

  let finalDbPasswordKey = 'DATABASE_PASSWORD';
  let finalDbPassword = '';

  const analyzedKey = (inferredKeys && inferredKeys.passwordKey) ? inferredKeys.passwordKey : (backendInfo.hasBackend ? await analyzeBackendForDbPasswordKey(backendInfo.backendPath) : null);

  // A usable password beats an example or default one, wherever each was found.
  foundDbPasswords = [...foundDbPasswords.filter(p => !p.untrusted), ...foundDbPasswords.filter(p => p.untrusted)];

  // An untrusted password still names the key; its value is generated instead.
  let withheldDbPassword = null;
  const passwordValueOf = (entry) => {
    if (!entry.untrusted) return entry.value;
    withheldDbPassword = `${entry.key} in ${entry.file} (${entry.untrusted})`;
    return crypto.randomBytes(16).toString('hex');
  };

  if (analyzedKey) {
    finalDbPasswordKey = analyzedKey;
    finalDbPassword = require('crypto').randomBytes(16).toString('hex');
    console.log(`\x1b[34mINFO: Analyzed backend code and found expected database password key: ${finalDbPasswordKey}\x1b[0m`);

    const envMatch = foundDbPasswords.find(p => p.key === finalDbPasswordKey);
    if (envMatch) {
      finalDbPassword = passwordValueOf(envMatch);
      if (!envMatch.untrusted) console.log(`\x1b[34mINFO: Found matching password for ${finalDbPasswordKey} in ${envMatch.file}\x1b[0m`);
    } else if (foundDbPasswords.length > 0) {
      finalDbPassword = passwordValueOf(foundDbPasswords[0]);
      if (!foundDbPasswords[0].untrusted) console.warn(`\x1b[33mWARNING: Backend code expects "${finalDbPasswordKey}", but ${foundDbPasswords[0].file} stores the database password under "${foundDbPasswords[0].key}". Using that value for ${finalDbPasswordKey} - please verify this is correct.\x1b[0m`);
    }
  } else if (foundDbPasswords.length > 0) {
    finalDbPasswordKey = foundDbPasswords[0].key;
    finalDbPassword = passwordValueOf(foundDbPasswords[0]);
    if (foundDbPasswords.length > 1) {
      console.log(`\x1b[33mWARNING: Found multiple database passwords in .env files. Using ${finalDbPasswordKey} from ${foundDbPasswords[0].file}\x1b[0m`);
    }
  } else if (dbInfo.hasDb) {
    if (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql') finalDbPasswordKey = 'POSTGRES_PASSWORD';
    else if (dbInfo.dbType === 'mysql') finalDbPasswordKey = 'MYSQL_ROOT_PASSWORD';
    else if (dbInfo.dbType === 'mariadb') finalDbPasswordKey = 'MARIADB_ROOT_PASSWORD';
    else if (dbInfo.dbType === 'mongodb') finalDbPasswordKey = 'MONGO_INITDB_ROOT_PASSWORD';
    else finalDbPasswordKey = 'DATABASE_PASSWORD';

    finalDbPassword = require('crypto').randomBytes(16).toString('hex');
    console.log(`\x1b[34mINFO: No database password found in .env files. Generated a secure random fallback password for ${finalDbPasswordKey}\x1b[0m`);
  }

  // When the primary database takes its password from a shared variable, that variable's canonical
  // key is used for the database too, and the backend's own name is mapped onto it.
  const primaryDbBlock = dbInfo.composeServiceName
    && composeServicesForCredentials[dbInfo.composeServiceName]
    && composeServicesForCredentials[dbInfo.composeServiceName].block;
  if (primaryDbBlock) {
    for (const ownerKey of CREDENTIAL_OWNER_ENV_KEYS) {
      const m = primaryDbBlock.match(new RegExp(`^\\s*${ownerKey}:\\s*(.+)$`, 'm'));
      if (!m) continue;
      const bareVar = extractBareVarRef(m[1]);
      if (!bareVar || !sharedCredentialSecrets.has(bareVar)) continue;
      const shared = sharedCredentialSecrets.get(bareVar);
      if (shared.secretKey !== finalDbPasswordKey) {
        console.log(`\x1b[34mINFO: the database password is the shared variable \${${bareVar}}, already wired as ${shared.secretKey} - using that key for the database too instead of a second secret named ${finalDbPasswordKey}.\x1b[0m`);
        if (finalDbPasswordKey && finalDbPasswordKey !== shared.secretKey) {
          // In place: the wiring object owns this list.
          const existing = apiExtraSecretEnvMappings.findIndex(mp => mp.envName === finalDbPasswordKey);
          if (existing !== -1) apiExtraSecretEnvMappings.splice(existing, 1);
          apiExtraSecretEnvMappings.push({ envName: finalDbPasswordKey, secretKey: shared.secretKey });
        }
        finalDbPasswordKey = shared.secretKey;
      }
      finalDbPassword = shared.value;
      withheldDbPassword = null;
      break;
    }
  }
  if (withheldDbPassword) {
    console.warn(`\x1b[33mWARNING: Not using the database password from ${withheldDbPassword} - it cannot be a production password. A random one was generated for ${finalDbPasswordKey} instead and written to deploy/.env.\x1b[0m`);
  }

  // Only the PBKDF2 hash of the dashboard password is stored anywhere; the password is shown once.
  let dashboardPassword = null;
  const envFile = path.join(deployDir, '.env');
  const envIO = new EnvFile(fs, envFile);

  let dashboardEnvContent = '';
  {
    const alreadyProvisioned = envIO.has('DASHBOARD_PASSWORD_HASH');
    if (!alreadyProvisioned) {
      dashboardPassword = crypto.randomBytes(18).toString('base64url');
      const salt = crypto.randomBytes(16);
      const iterations = 600000;
      const derived = crypto.pbkdf2Sync(dashboardPassword, salt, iterations, 32, 'sha256');
      const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
      // Single-quoted: the hash contains "$".
      dashboardEnvContent = `DASHBOARD_PASSWORD_HASH='pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(derived)}'\n`;
    }
  }

  // Each shared credential gets one line, under its canonical key.
  for (const { secretKey, value } of sharedCredentialSecrets.values()) {
    if (!new RegExp('^' + escapeRegex(secretKey) + '=', 'm').test(sensitiveEnvContent)) {
      sensitiveEnvContent += `${secretKey}="${value}"\n`;
    }
  }

  // The SSH key goes last: it is one very long value, and anything after it is easy to miss.
  let envContent = `# ============================================================================
# Every NAME below must be created as a GitHub repository secret with the same
# name and the value shown, or the deployment will not come up:
#
#   your repository -> Settings -> Secrets and variables -> Actions
#                   -> New repository secret
#
# This file is NOT committed (deploy/.env is gitignored) and is not read at
# deploy time - it exists so you know what to create. The sections say where
# each value came from.
# ============================================================================

# --- Created by Flarops for the infrastructure it provisions -----------------
AWS_ACCESS_KEY_ID="${awsCredentials.accessKey}"
AWS_SECRET_ACCESS_KEY="${awsCredentials.secretKey}"
REGISTRY_PASSWORD="${registryPassword}"
`;

  if (cloudflareApiToken && cloudflareZoneId) {
    envContent += `CLOUDFLARE_API_TOKEN="${cloudflareApiToken}"\n`;
    envContent += `CLOUDFLARE_ZONE_ID="${cloudflareZoneId}"\n`;
  }

  if (sensitiveEnvContent && sensitiveEnvContent.trim()) {
    envContent += `\n# --- Found in your project's own .env files ---------------------------------\n${sensitiveEnvContent}`;
  }

  if (finalDbPassword && !new RegExp('^' + escapeRegex(finalDbPasswordKey) + '=', 'm').test(envContent)) {
    envContent += `${finalDbPasswordKey}="${finalDbPassword}"\n`;
  }

  if (dashboardEnvContent) {
    envContent += `\n# --- Generated by Flarops for the deployment dashboard ----------------------\n${dashboardEnvContent}`;
  }

  envContent += `
# --- The deploy key Flarops generated for this repository -------------------
# One value on one very long line. Copy it whole, including both -----markers.
SSH_PRIVATE_KEY="${privateKey}"
`;

  if (!envIO.exists()) {
    envIO.write(envContent);
    console.log("Created deploy/.env");
  } else {
    let appended = false;

    if (finalDbPassword && !envIO.has(finalDbPasswordKey)) {
      envIO.append(`\n${finalDbPasswordKey}="${finalDbPassword}"\n`);
      console.log(`Appended fallback ${finalDbPasswordKey} to deploy/.env`);
      appended = true;
    }

    // The dashboard hash is appended separately: it is generated, not extracted.
    if (dashboardEnvContent && !envIO.has('DASHBOARD_PASSWORD_HASH')) {
      envIO.append(`\n# --- Generated by Flarops for the deployment dashboard ----------------------\n${dashboardEnvContent}`);
      appended = true;
    }

    const sensitiveLines = sensitiveEnvContent.split('\n');
    for (const sLine of sensitiveLines) {
      if (sLine.trim()) {
        const key = sLine.split('=')[0];
        if (!envIO.has(key)) {
          envIO.append(`${sLine}\n`);
          appended = true;
        }
      }
    }

    if (!appended) {
      console.log("deploy/.env already exists and is up to date");
    }
  }
  try {
    fs.chmodSync(envFile, 0o600);
  } catch (e) { /* best-effort - not fatal if the filesystem doesn't support it */ }

  const envSafetyFile = path.join(deployDir, '.env.safety');
  const envSafetyContent = `DATABASE_USER=
DATABASE_TYPE=${dbInfo.hasDb ? dbInfo.dbType : ''}
DOCKER_REGISTRY=${dockerRegistry}
DOMAIN=${domain}
AWS_REGION=${awsRegion}
`;
  if (!fs.existsSync(envSafetyFile)) {
    fs.writeFileSync(envSafetyFile, envSafetyContent);
    console.log("Created deploy/.env.safety");
  } else {
    console.log("deploy/.env.safety already exists");
  }
  const helmDir = path.join(deployDir, 'helm');
  const helmTemplatesDir = path.join(helmDir, 'templates');
  if (!fs.existsSync(helmDir)) {
    fs.mkdirSync(helmDir, { recursive: true });
    fs.mkdirSync(helmTemplatesDir, { recursive: true });
    console.log("Created deploy/helm and deploy/helm/templates directories");
  }

  let apiRoutes = ['/api'];
  if (refactoredRoutes && refactoredRoutes.length > 0) {
    apiRoutes = refactoredRoutes;
    console.log(`Using API Routes discovered during refactoring: ${apiRoutes.join(', ')}`);
  } else {
    // Routes the frontend calls are the authority when they can be read.
    let discoveredRoutes = [];
    if (frontendInfo.frontendPath) {
      discoveredRoutes = await analyzeFrontendRoutes(frontendInfo.frontendPath);
      if (discoveredRoutes.length > 0) {
        apiRoutes = discoveredRoutes;
        console.log(`Discovered API Routes in frontend: ${apiRoutes.join(', ')}`);
      }
    }

    // Otherwise, the routes the backend mounts.
    if (discoveredRoutes.length === 0 && backendInfo.backendPath) {
      const { analyzeBackendExposedRoutes } = require('../../utils/routeAnalyzer');
      const backendRoutes = await analyzeBackendExposedRoutes(backendInfo.backendPath);
      if (backendRoutes.length > 0) {
        apiRoutes = backendRoutes;
        console.log(`Discovered API Routes in backend source: ${apiRoutes.join(', ')}`);
      }
    }
  }

  // A gateway config (location -> proxy_pass port) says which service owns a route prefix.
  if (additionalServices.length > 0 && apiRoutes.length > 0) {
    const gatewayRoutePorts = await findRoutePortMapFromGatewayConfig(currentDir);
    if (gatewayRoutePorts.size > 0) {
      const stillApiRoutes = [];
      for (const route of apiRoutes) {
        const ownerPort = gatewayRoutePorts.get(route);
        const ownerService = ownerPort ? additionalServices.find(s => s.ports.includes(ownerPort)) : null;
        if (ownerService) {
          if (!ownerService.exposedRoutes.includes(route)) {
            ownerService.exposedRoutes.push(route);
          }
          console.log(`Reassigned route ${route} to ${ownerService.name} (per gateway config, port ${ownerPort})`);
        } else {
          stillApiRoutes.push(route);
        }
      }
      apiRoutes = stillApiRoutes;
    }
  }

  // Services behind the project's own API gateway are not exposed directly, so the gateway cannot be
  // bypassed. Only services the gateway demonstrably talks to are affected.
  if (additionalServices.length > 0) {
    // The gateway need not be the primary backend.
    let gateway = null;
    if (backendInfo.backendPath) {
      const apiComposeNames = Object.keys(composeNameToK8s).filter(k => composeNameToK8s[k] === 'api');
      const isGateway = await detectServiceIsGateway(backendInfo.backendPath, [
        path.basename(backendInfo.backendPath), ...apiComposeNames,
      ]);
      if (isGateway) {
        gateway = {
          label: path.basename(backendInfo.backendPath),
          composeNames: apiComposeNames,
          env: apiEnv,
          service: null,
        };
      }
    }
    if (!gateway) {
      for (const s of additionalServices) {
        const isGateway = await detectServiceIsGateway(s.path, [s.name, s.originalName, s.composeName]);
        if (!isGateway) continue;
        gateway = {
          label: s.name,
          composeNames: [s.composeName, s.originalName, s.name].filter(Boolean),
          env: s.env || {},
          service: s,
        };
        break;
      }
    }

    if (gateway) {
      const composeGraph = await parseComposeServices(currentDir);
      const gatewayDependsOn = new Set();
      for (const name of gateway.composeNames) {
        for (const dep of (composeGraph[name] && composeGraph[name].dependsOn) || []) gatewayDependsOn.add(dep);
      }
      const gatewayEnvValuesText = Object.values(gateway.env).join(' ');
      // A hand-rolled gateway often hardcodes upstream hostnames in source.
      let gatewaySourceText = '';
      if (gateway.service && gateway.service.path) {
        try {
          for (const entry of fs.readdirSync(gateway.service.path, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (!/\.(js|mjs|cjs|ts|go|py|rb|php|java|kt|yaml|yml|json|conf)$/i.test(entry.name)) continue;
            gatewaySourceText += '\n' + fs.readFileSync(path.join(gateway.service.path, entry.name), 'utf8');
          }
        } catch (e) { /* unreadable - fall back to the other signals */ }
      }
      const haystack = gatewayEnvValuesText + '\n' + gatewaySourceText;
      const referencesHostname = (name) => !!name && new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegex(name)}([^A-Za-z0-9_.-]|$)`).test(haystack);

      // A Eureka gateway resolves services at request time: Eureka clients are reachable through it.
      const EUREKA_KEY_REGEX = /^EUREKA/i;
      const gatewayUsesEureka = Object.keys(gateway.env).some(k => EUREKA_KEY_REGEX.test(k));

      const suppressed = [];
      for (const s of additionalServices) {
        if (gateway.service && s === gateway.service) continue;
        if (!s.exposedRoutes || s.exposedRoutes.length === 0) continue;
        const referencedByGateway = gatewayDependsOn.has(s.name) || gatewayDependsOn.has(s.originalName) ||
          gatewayDependsOn.has(s.composeName) ||
          referencesHostname(s.name) || (s.originalName !== s.name && referencesHostname(s.originalName)) ||
          (gatewayUsesEureka && Object.keys(s.env || {}).some(k => EUREKA_KEY_REGEX.test(k)));
        if (!referencedByGateway) continue;

        s.suppressDirectIngress = true;
        suppressed.push(`${s.name} (${s.exposedRoutes.join(', ')})`);
      }
      if (suppressed.length > 0) {
        console.log(`\x1b[34mINFO: "${gateway.label}" looks like this project's own API gateway, so these routes were left reachable only through it and NOT added directly to Ingress: ${suppressed.join('; ')}. If any of these must bypass the gateway, set additionalServices.<name>.exposeDirectly: true in deploy/helm/values.yaml.\x1b[0m`);
      }
    }
  }

  // A database's compose `command:` carries its server settings (postgres -c wal_level=logical).
  // Compose fills ${VAR} from .env, which a pod's args cannot; such a command is left to flarops.yaml.
  const dbCommandWarnings = [];
  const composeDbCommand = async (composeServiceName, label) => {
    if (!composeServiceName) return null;
    try {
      const composeServices = await parseComposeServices(currentDir);
      const block = composeServices[composeServiceName] && composeServices[composeServiceName].block;
      const args = block ? extractCommand(block) : null;
      if (!args) return null;
      if (args.some(a => /\$\{?[A-Za-z_]/.test(a))) {
        dbCommandWarnings.push(`${label}: "${args.join(' ')}"`);
        return null;
      }
      return args;
    } catch (e) { return null; }
  };
  const dbCommand = dbInfo.hasDb ? await composeDbCommand(dbInfo.composeServiceName, 'database') : null;

  // Bootstrap SQL mounted into /docker-entrypoint-initdb.d is often the only schema definition.
  let dbInitFiles = null;
  const dbInitWarnings = [];
  if (dbInfo.hasDb && dbInfo.composeServiceName) {
    try {
      const { extractVolumes, materializeBindMounts } = require('../../utils/composeSupport.js');
      const composeServices = await parseComposeServices(currentDir);
      const dbBlock = composeServices[dbInfo.composeServiceName] && composeServices[dbInfo.composeServiceName].block;
      if (dbBlock) {
        const { bindMounts } = extractVolumes(dbBlock);
        const initMounts = bindMounts.filter(m => /^\/docker-entrypoint-initdb\.d(\/|$)/.test(String(m.target || '')));
        if (initMounts.length > 0) {
          const carried = materializeBindMounts(fs, path, composeDir, initMounts);
          if (carried.data) dbInitFiles = carried.data;
          for (const u of carried.unresolved) {
            dbInitWarnings.push(`${u.source} -> ${u.target} (${u.reason})`);
          }
        }
      }
    } catch (e) { /* no compose, or unreadable - nothing to carry */ }
  }

  const rawRelativeBackendPath = backendInfo.backendPath ? path.relative(currentDir, backendInfo.backendPath) || '.' : null;
  const rawRelativeFrontendPath = frontendInfo.frontendPath ? path.relative(currentDir, frontendInfo.frontendPath) || '.' : null;

  // A Dockerfile that COPYs a sibling directory needs the repo root as build context.
  const backendNeedsRootContext = backendInfo.needsRootContext && rawRelativeBackendPath && rawRelativeBackendPath !== '.';
  const frontendNeedsRootContext = frontendInfo.needsRootContext && rawRelativeFrontendPath && rawRelativeFrontendPath !== '.';

  const relativeBackendPath = backendNeedsRootContext ? '.' : rawRelativeBackendPath;
  const relativeFrontendPath = frontendNeedsRootContext ? '.' : rawRelativeFrontendPath;

  // Any root build context gets a .dockerignore keeping deploy/ out of the image.
  const anyServiceUsesRootContext = relativeBackendPath === '.' || relativeFrontendPath === '.' ||
    additionalServices.some(s => s.isMavenReactorModule || s.relativePath === '.' || s.relativePath === '');

  if (anyServiceUsesRootContext) {
    const dockerignoreFile = path.join(currentDir, '.dockerignore');
    // And the repository's .env and .keys/: "COPY . ." would bake them into a pushed image.
    const dockerignoreLinesToAdd = ['deploy/', '.env', '.env.*', '.keys/'];

    if (!fs.existsSync(dockerignoreFile)) {
      fs.writeFileSync(dockerignoreFile, '#autogenerated by flarops\n' + dockerignoreLinesToAdd.join('\n') + '\n');
      console.log("Created .dockerignore to keep deploy/ out of application build contexts");
    } else {
      const dockerignoreContent = fs.readFileSync(dockerignoreFile, 'utf8');
      const existingLines = new Set(dockerignoreContent.split('\n').map(line => line.trim()));
      const linesToAdd = dockerignoreLinesToAdd.filter(line => !existingLines.has(line));

      if (linesToAdd.length > 0) {
        let appendStr = '#autogenerated by flarops\n' + linesToAdd.join('\n') + '\n';
        if (dockerignoreContent.length > 0 && !dockerignoreContent.endsWith('\n')) {
          appendStr = '\n' + appendStr;
        }
        fs.appendFileSync(dockerignoreFile, appendStr);
        console.log(`Appended ${linesToAdd.length} rule(s) to .dockerignore`);
      }
    }
  }

  const apiDockerfilePath = backendNeedsRootContext
    ? `${rawRelativeBackendPath}/${backendInfo.dockerfile || 'Dockerfile'}`
    : (backendInfo.dockerfile || 'Dockerfile');
  const frontendDockerfilePath = frontendNeedsRootContext
    ? `${rawRelativeFrontendPath}/${frontendInfo.dockerfile || 'Dockerfile'}`
    : (frontendInfo.dockerfile || 'Dockerfile');

  // A migration step runs as an initContainer before the API.
  const apiMigrationStep = backendInfo.backendPath ? await detectApiMigrationStep(backendInfo.backendPath) : null;
  if (apiMigrationStep) {
    console.log(`\x1b[34mINFO: Detected a migration step in the backend (${apiMigrationStep.command}) - it will run as an initContainer before the API starts.\x1b[0m`);
  }

  // Memory scales with the worker processes the Dockerfile starts.
  const apiWorkers = (backendInfo.backendPath && backendInfo.dockerfile)
    ? await detectApiWorkerCount(backendInfo.backendPath, backendInfo.dockerfile)
    : 1;
  if (apiWorkers > 1) {
    console.log(`\x1b[34mINFO: Detected ${apiWorkers} worker processes in the API's Dockerfile - scaling its memory requests/limits accordingly.\x1b[0m`);
  }

  const allEnvKeys = [];
  const envMatches = envContent.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm);
  for (const match of envMatches) {
    allEnvKeys.push(match[1]);
  }

  const excludedKeys = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SSH_PRIVATE_KEY', 'REGISTRY_USER', 'REGISTRY_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID']);
  const envKeysToPass = allEnvKeys.filter(k => !excludedKeys.has(k));
  // Only when a database password was actually found or generated.
  const hasDbPassword = !!finalDbPassword;
  if (hasDbPassword && finalDbPasswordKey && !envKeysToPass.includes(finalDbPasswordKey)) envKeysToPass.push(finalDbPasswordKey);

  // The chart always wires DASHBOARD_PASSWORD_HASH, so CI always passes it.
  if (!envKeysToPass.includes('DASHBOARD_PASSWORD_HASH')) envKeysToPass.push('DASHBOARD_PASSWORD_HASH');

  // Deduplicated: a duplicate becomes duplicate env entries, which the API server rejects.
  const sensitiveKeys = [...new Set([
    ...sensitiveEnvContent.split('\n').map(l => l.split('=')[0]).filter(k => k && k.trim()),
    ...(finalDbPasswordKey && finalDbPassword ? [finalDbPasswordKey] : []),
  ])];

  const apiSecretKeys = sensitiveKeys.filter(k => backendInfo.usedEnvVars && backendInfo.usedEnvVars.includes(k));
  const frontendSecretKeys = sensitiveKeys.filter(k => frontendInfo.usedEnvVars && frontendInfo.usedEnvVars.includes(k));

  // Every key rendered as a secretKeyRef must also be passed by CI and listed in deploy/.env, or the
  // pod cannot start.
  let lateSectionWritten = false;
  const lateSecretKeys = [];
  const registerSecretKeyForCI = (key) => {
    if (!key) return;
    if (!envKeysToPass.includes(key)) envKeysToPass.push(key);
    if (!envIO.has(key)) {
      const known = sharedCredentialSecrets.get(key);
      const value = known ? known.value : (apiEnv[key] || frontendEnv[key] || '');
      if (!lateSectionWritten) {
        envIO.append(`\n# --- Required because a service in your stack reads them ---------------------\n# Values shown as \${OTHER_KEY} must be given the SAME value as that key.\n`);
        lateSectionWritten = true;
      }
      lateSecretKeys.push(key);
      envIO.append(`${key}="${String(value).replace(/"/g, '\\"')}"\n`);
    }
  };

  for (const k of apiForcedSecretKeys) {
    if (!apiSecretKeys.includes(k)) apiSecretKeys.push(k);
    registerSecretKeyForCI(k);
  }
  for (const k of frontendForcedSecretKeys) {
    if (!frontendSecretKeys.includes(k)) frontendSecretKeys.push(k);
    registerSecretKeyForCI(k);
  }

  for (const s of additionalServices) {
    s.secretKeys = sensitiveKeys.filter(k => s.usedEnvVars && s.usedEnvVars.includes(k));
    for (const k of s.forcedSecretKeys || []) {
      if (!s.secretKeys.includes(k)) s.secretKeys.push(k);
      registerSecretKeyForCI(k);
    }
    // The DB password reaches a service only if its own source reads it.
    s.dbPasswordKey = (dbInfo.hasDb && finalDbPasswordKey && s.usedEnvVars && s.usedEnvVars.includes(finalDbPasswordKey)) ? finalDbPasswordKey : null;
  }

  // An additional service with a different database gets a database of its own.
  for (const s of additionalServices) {
    const serviceDb = await analyzeDatabase(currentDir, s.path);
    const isDistinctDb = serviceDb.hasDb && (!dbInfo.hasDb || serviceDb.dbType !== dbInfo.dbType || serviceDb.image !== dbInfo.image);
    if (!isDistinctDb) continue;

    const serviceUpper = s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const passwordKeyBase = passwordKeyFor(serviceDb.dbType);
    const defaultUser = defaultUserFor(serviceDb.dbType);
    const passwordKey = `${serviceUpper}_${passwordKeyBase}`;
    const password = crypto.randomBytes(16).toString('hex');

    if (!envIO.has(passwordKey)) {
      envIO.append(`\n${passwordKey}="${password}"\n`);
      console.log(`\x1b[34mINFO: Generated a database for additional service "${s.name}" (${serviceDb.dbType}) - password stored under ${passwordKey} in deploy/.env\x1b[0m`);
    }
    if (!envKeysToPass.includes(passwordKey)) envKeysToPass.push(passwordKey);
    if (!s.secretKeys.includes(passwordKey)) s.secretKeys.push(passwordKey);

    s.db = {
      type: serviceDb.dbType,
      image: serviceDb.image,
      port: serviceDb.port,
      user: serviceDb.dbUser || defaultUser,
      name: serviceDb.dbName || `${s.name}db`,
      passwordKey,
      composeServiceName: serviceDb.composeServiceName || null
    };
    const ownDbCommand = await composeDbCommand(serviceDb.composeServiceName, `${s.name}.db`);
    if (ownDbCommand) s.db.command = ownDbCommand;

    // Spring Data MongoDB: SPRING_DATA_MONGODB_URI, built against the service's own database.
    const isSpringMongo = await detectSpringDataMongoConfig(s.path);
    if (isSpringMongo && serviceDb.dbType === 'mongodb') {
      delete s.env['SPRING_DATA_MONGODB_URI'];
      if (!s.dbUrlVars.some(v => v.key === 'SPRING_DATA_MONGODB_URI')) {
        s.dbUrlVars.push({ key: 'SPRING_DATA_MONGODB_URI', dbName: s.db.name });
      }
      continue;
    }

    const isSpring = await detectSpringDatasourceConfig(s.path);
    if (isSpring) {
      // Spring binds SPRING_DATASOURCE_* from the environment by itself.
      const jdbcScheme = serviceDb.dbType === 'mysql' ? 'mysql' : (serviceDb.dbType === 'mariadb' ? 'mariadb' : 'postgresql');
      s.env['SPRING_DATASOURCE_URL'] = `jdbc:${jdbcScheme}://${s.name}-db:${serviceDb.port}/${s.db.name}`;
      s.env['SPRING_DATASOURCE_USERNAME'] = s.db.user;
      s.springDatasourcePasswordSecretKey = passwordKey;
      // SPRING_DATASOURCE_PASSWORD now comes from its dedicated block; a second entry would be a duplicate.
      const rawIdx = s.secretKeys.indexOf('SPRING_DATASOURCE_PASSWORD');
      if (rawIdx !== -1) s.secretKeys.splice(rawIdx, 1);

      // It is not read under that name, so it is not demanded as a GitHub secret either.
      const deadKeyIdx = envKeysToPass.indexOf('SPRING_DATASOURCE_PASSWORD');
      if (deadKeyIdx !== -1 && 'SPRING_DATASOURCE_PASSWORD' !== passwordKey) {
        envKeysToPass.splice(deadKeyIdx, 1);
        envIO.removeKey('SPRING_DATASOURCE_PASSWORD');
        console.log(`\x1b[34mINFO: "SPRING_DATASOURCE_PASSWORD" was found in the project but Spring's relaxed environment-variable binding means the container never reads a secret under that exact name - it uses ${passwordKey} instead (wired automatically). Removed it from the required GitHub secrets and deploy/.env.\x1b[0m`);
      }
    } else {
      const dbUrlRefactorResult = await refactorBackendDbUrl(s.path, true);
      if (dbUrlRefactorResult && dbUrlRefactorResult.discoveredVars.length > 0) {
          for (const key of dbUrlRefactorResult.discoveredVars) {
          if (!s.dbUrlVars.some(v => v.key === key)) s.dbUrlVars.push({ key });
        }
      }
    }
  }

  // Services on the shared database server, each with its own database name.
  if (dbInfo.hasDb) {
    for (const s of additionalServices) {
      if (s.db || !Array.isArray(s.dbUrlVars) || s.dbUrlVars.length === 0) continue;

      const ownCompose = await analyzeServiceDatabaseFromCompose(currentDir, s.path);
      s.db = {
        type: dbInfo.dbType,
        image: dbInfo.image,
        port: dbInfo.port,
        user: dbInfo.dbUser || defaultUserFor(dbInfo.dbType),
        name: null, // each dbUrlVars entry below carries its own db name
        passwordKey: finalDbPasswordKey,
        shared: true,
        composeServiceName: (ownCompose && ownCompose.composeServiceName) || dbInfo.composeServiceName || null
      };
      if (finalDbPasswordKey && !s.secretKeys.includes(finalDbPasswordKey)) {
        s.secretKeys.push(finalDbPasswordKey);
      }
    }
  }

  // Services that read separate HOST/USER/PASSWORD variables instead of a URL.
  if (dbInfo.hasDb) {
    const isUpper = (k) => !!k && k === k.toUpperCase();
    for (const s of additionalServices) {
      if (s.db && !s.db.shared) continue;

      const svcKeys = await analyzeBackendForDbKeys(s.path);
      if (isUpper(svcKeys.hostKey) && !s.env[svcKeys.hostKey]) {
        s.env[svcKeys.hostKey] = 'database';
      }
      if (isUpper(svcKeys.userKey) && !s.env[svcKeys.userKey]) {
        s.env[svcKeys.userKey] = dbInfo.dbUser || defaultUserFor(dbInfo.dbType);
      }
      if (isUpper(svcKeys.passwordKey) && finalDbPasswordKey) {
        if (svcKeys.passwordKey === finalDbPasswordKey) {
          if (!s.secretKeys.includes(finalDbPasswordKey)) s.secretKeys.push(finalDbPasswordKey);
        } else {
          // Map the app's password name onto the shared key; do not rename either.
              if (!s.extraSecretEnvMappings.some(m => m.envName === svcKeys.passwordKey)) {
            s.extraSecretEnvMappings.push({ envName: svcKeys.passwordKey, secretKey: finalDbPasswordKey });
          }
        }
      }
    }
  }

  // A key that is a secret is never also a plain env value on the same service (see
  // dedupeEnvAgainstSecrets below).

  // An unresolved build arg is dropped (the Dockerfile default applies), except the frontend's API URL.
  const droppedBuildArgs = [];
  const rewrittenBuildArgs = [];

  // A loopback URL in a build arg is compiled into the image: rewrite it to the project's domain.
  const LOOPBACK_URL_REGEX = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/gi;
  const rewriteLoopback = (label, key, value) => {
    if (!domain || !LOOPBACK_URL_REGEX.test(value)) {
      LOOPBACK_URL_REGEX.lastIndex = 0;
      return value;
    }
    LOOPBACK_URL_REGEX.lastIndex = 0;
    const rewritten = value.replace(LOOPBACK_URL_REGEX, `https://${domain}`);
    rewrittenBuildArgs.push(`${label}.${key} (${value} -> ${rewritten})`);
    return rewritten;
  };

  const resolveBuildArgs = (args, label) => {
    if (!args) return null;
    const out = {};
    for (const [key, rawVal] of Object.entries(args)) {
      const val = String(rawVal);
      if (!/\$\{?[A-Za-z_]/.test(val)) {
        out[key] = rewriteLoopback(label, key, val);
        continue;
      }
      const fromEnv = apiEnv[key] || frontendEnv[key];
      if (fromEnv && !/\$\{?[A-Za-z_]/.test(String(fromEnv))) {
        out[key] = rewriteLoopback(label, key, String(fromEnv));
        continue;
      }
      if (domain && /^(VITE_|REACT_APP_|NEXT_PUBLIC_|NG_|VUE_APP_)?API(_BASE)?_(URL|URI|ENDPOINT)$/i.test(key)) {
        out[key] = `https://${domain}`;
        continue;
      }
      droppedBuildArgs.push(`${label}.${key}`);
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  // Public-prefix variables (VITE_, NEXT_PUBLIC_, ...) are inlined at build time, so they are also
  // passed as build args.
  const publicEnvAsBuildArgs = {};
  for (const [key, value] of Object.entries(frontendEnv)) {
    if (!PUBLIC_CLIENT_ENV_PREFIX_REGEX.test(key)) continue;
    if (frontendBuildArgs && Object.prototype.hasOwnProperty.call(frontendBuildArgs, key)) continue;
    publicEnvAsBuildArgs[key] = value;
  }
  if (Object.keys(publicEnvAsBuildArgs).length > 0) {
    frontendBuildArgs = { ...(frontendBuildArgs || {}), ...publicEnvAsBuildArgs };
    console.log(`\x1b[34mINFO: These frontend variables use a framework prefix that inlines them into the bundle at BUILD time, so they were also passed to the image build in deploy/werf.yaml: ${Object.keys(publicEnvAsBuildArgs).join(', ')}. Setting them in values.yaml alone would have had no effect.\x1b[0m`);
  }

  apiBuildArgs = resolveBuildArgs(apiBuildArgs, 'api');
  frontendBuildArgs = resolveBuildArgs(frontendBuildArgs, 'frontend');
  for (const s of additionalServices) {
    if (s.buildArgs) s.buildArgs = resolveBuildArgs(s.buildArgs, s.name);
  }
  if (rewrittenBuildArgs.length > 0) {
    console.log(`\x1b[34mINFO: These docker-compose build args pointed at a loopback address, which is compiled into the image and is never reachable from a pod - they were rewritten to the project's own domain: ${rewrittenBuildArgs.join(', ')}. Adjust them in deploy/werf.yaml if a different address is correct.\x1b[0m`);
  }
  if (droppedBuildArgs.length > 0) {
    console.warn(`\x1b[33mWARNING: These docker-compose build args reference a value this repository never defines, so they were left to the Dockerfile's own ARG defaults: ${droppedBuildArgs.join(', ')}. If a default is a development value, set the real one in werf.yaml.\x1b[0m`);
  }

  // Everything the hostname rewrite depends on is settled now.
  resolveComposeDatabaseNames();

  // Supporting services: only the ones the application references are generated.
  const supportServices = [];
  const supportBindMountWarnings = [];
  const supportConfigMapNotes = [];
  const skippedNodeAgents = [];
  if (composeSupportCandidates.size > 0) {
    const generatedNames = new Set(Object.keys(composeNameToK8s));
    // "<service>-db" names are taken.
    for (const s of additionalServices) {
      if (s.db && !s.db.shared) usedNames.add(`${s.name}-db`);
    }
    const composeGraph = await parseComposeServices(currentDir);

    // Referenced: named in an env value, a command argument, or a depends_on of a generated service.
    const referenceHaystack = () => {
      const parts = [];
      const collect = (envObj, command) => {
        for (const v of Object.values(envObj || {})) parts.push(String(v));
        for (const a of command || []) parts.push(String(a));
      };
      collect(apiEnv, apiCommand);
      collect(frontendEnv, frontendCommand);
      for (const s of additionalServices) collect(s.env, s.command);
      for (const s of supportServices) collect(s.env, s.command);
      return parts.join('\n');
    };

    const appComposeNames = new Set(Object.keys(composeNameToK8s));
    const dependedOnByApp = new Set();
    for (const name of appComposeNames) {
      for (const dep of (composeGraph[name] && composeGraph[name].dependsOn) || []) dependedOnByApp.add(dep);
    }

    // Transitive: a supporting service can need another (Keycloak needs its own Postgres).
    const chosen = new Set();
    let added = true;
    while (added) {
      added = false;
      const haystack = referenceHaystack();
      for (const [composeName, block] of composeSupportCandidates) {
        if (chosen.has(composeName)) continue;
        if (generatedNames.has(composeName)) continue;

        const referencedInValues = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegex(composeName)}([^A-Za-z0-9_.-]|$)`).test(haystack);
        const neededByChosen = Array.from(chosen).some(c =>
          ((composeGraph[c] && composeGraph[c].dependsOn) || []).includes(composeName));
        if (!referencedInValues && !dependedOnByApp.has(composeName) && !neededByChosen) continue;

        const parsed = parseSupportService(composeName, block);
        if (!parsed) continue;
        if (usedNames.has(parsed.name)) continue; // name already taken by a generated object

        // Node-level agents belong in a DaemonSet installed deliberately, not in this chart.
        if (parsed.isNodeAgent) {
          skippedNodeAgents.push(composeName);
          chosen.add(composeName);
          continue;
        }

        // Their secrets go through the project Secret too.
        parsed.secretKeys = [];
        parsed.extraSecretEnvMappings = [];

        if (Array.isArray(parsed.command)) {
          for (let i = 0; i < parsed.command.length; i++) {
            const bareVar = extractBareVarRef(parsed.command[i]);
            if (!bareVar || !sharedCredentialSecrets.has(bareVar)) continue;
            const { secretKey } = sharedCredentialSecrets.get(bareVar);
            parsed.command[i] = `$(${secretKey})`;
            if (!parsed.secretKeys.includes(secretKey)) parsed.secretKeys.push(secretKey);
          }
        }

        for (const key of Object.keys(parsed.env)) {
          const rawVal = parsed.env[key];

          // A credential this component owns or shares with another owner: wire it to that one secret.
          const bareVar = extractBareVarRef(rawVal);
          const shared = bareVar ? sharedCredentialSecrets.get(bareVar) : null;
          if (shared) {
            delete parsed.env[key];
            if (key === shared.secretKey) {
              if (!parsed.secretKeys.includes(key)) parsed.secretKeys.push(key);
            } else if (!parsed.extraSecretEnvMappings.some(m => m.envName === key)) {
              parsed.extraSecretEnvMappings.push({ envName: key, secretKey: shared.secretKey });
            }
            continue;
          }

          if (isSensitiveKey(key)) {
            delete parsed.env[key];
            if (!parsed.secretKeys.includes(key)) parsed.secretKeys.push(key);
            if (!envIO.has(key)) {
              envIO.append(`${key}=${usableSecretValue(key, sanitizeEnvValue(rawVal, key, { parsed: true }), composeFilePath)}\n`);
            }
            if (!envKeysToPass.includes(key)) envKeysToPass.push(key);
          } else {
            parsed.env[key] = sanitizeEnvValue(rawVal, key, { parsed: true });
          }
        }
        if (parsed.extraSecretEnvMappings.length === 0) delete parsed.extraSecretEnvMappings;

        // Bind-mounted configuration is carried as a ConfigMap.
        if (parsed.bindMounts.length > 0) {
          const carried = materializeBindMounts(fs, path, composeDir, parsed.bindMounts);
          if (carried.data) {
            parsed.configMapData = carried.data;
            parsed.configFileMounts = carried.fileMounts;
            parsed.configDirMounts = carried.dirMounts;
          }
          for (const u of carried.unresolved) {
            supportBindMountWarnings.push(`${composeName}: ${u.source} -> ${u.target} (${u.reason})`);
          }
          const carriedCount = carried.data ? Object.keys(carried.data).length : 0;
          if (carriedCount > 0) {
            supportConfigMapNotes.push(`${parsed.name} (${carriedCount} file(s))`);
          }
        }

        chosen.add(composeName);
        usedNames.add(parsed.name);
        supportServices.push(parsed);
        composeNameToK8s[composeName] = parsed.name;
        added = true;
      }
    }
  }

  for (const [containerName, serviceKey] of composeContainerNames) {
    const target = composeNameToK8s[serviceKey];
    if (target && !composeNameToK8s[containerName]) composeNameToK8s[containerName] = target;
  }

  rewriteComposeHostnames();
  // Supporting services' own hostnames are rewritten too.
  for (const s of supportServices) {
    const wrapper = { env: s.env };
    rewriteComposeHostnamesIn(wrapper.env);
    if (s.command) s.command = rewriteComposeHostnamesInList(s.command);
  }

  // A loopback URL inside a pod means the pod itself. A browser-read value gets the domain; a URL whose
  // port matches a deployed service gets that service; anything else is left and reported.
  const loopbackServiceByPort = new Map();
  {
    const claim = (ports, name) => {
      for (const p of ports || []) {
        const port = Number(p);
        if (port && !loopbackServiceByPort.has(port)) loopbackServiceByPort.set(port, name);
      }
    };
    if (backendInfo.hasBackend) claim(backendInfo.ports, 'api');
    if (frontendInfo.hasFrontend) claim(frontendInfo.ports, 'frontend');
    for (const s of additionalServices) claim(s.ports, s.name);
    for (const s of supportServices) claim(s.ports, s.name);
    if (dbInfo.hasDb && dbInfo.port) claim([dbInfo.port], 'database');
  }

  const rewrittenRuntimeEnv = [];
  const rewriteLoopbackIn = (envObj, label) => {
    if (!envObj) return;
    for (const key of Object.keys(envObj)) {
      const before = String(envObj[key]);
      LOOPBACK_URL_REGEX.lastIndex = 0;
      if (!LOOPBACK_URL_REGEX.test(before)) continue;
      LOOPBACK_URL_REGEX.lastIndex = 0;
      const after = before.replace(LOOPBACK_URL_REGEX, (match) => {
        if (PUBLIC_CLIENT_ENV_PREFIX_REGEX.test(key)) return domain ? `https://${domain}` : match;
        const port = (match.match(/:(\d+)$/) || [])[1];
        const service = port ? loopbackServiceByPort.get(Number(port)) : null;
        if (service) return `http://${service}:${port}`;
        return match;
      });
      if (after !== before) {
        envObj[key] = after;
        rewrittenRuntimeEnv.push(`${label}.${key} (${before} -> ${after})`);
      }
    }
  };

  rewriteLoopbackIn(apiEnv, 'api');
  rewriteLoopbackIn(frontendEnv, 'frontend');
  for (const s of additionalServices) rewriteLoopbackIn(s.env, s.name);
  for (const s of supportServices) rewriteLoopbackIn(s.env, s.name);
  if (rewrittenRuntimeEnv.length > 0) {
    console.log(`\x1b[34mINFO: These environment variables pointed at a loopback address, which inside a pod means the pod itself - they were rewritten: ${rewrittenRuntimeEnv.join(', ')}.\x1b[0m`);
  }

  // Whatever still points at this machine is listed by name.
  const unresolvedLoopback = [];
  const collectLoopback = (envObj, label) => {
    for (const [key, value] of Object.entries(envObj || {})) {
      if (LOOPBACK_HOST_REGEX.test(String(value))) unresolvedLoopback.push(`${label}.${key}`);
    }
  };
  collectLoopback(apiEnv, 'api');
  collectLoopback(frontendEnv, 'frontend');
  for (const s of additionalServices) collectLoopback(s.env, s.name);
  for (const s of supportServices) collectLoopback(s.env, s.name);

  // An unresolved reference in a command argument is reported like an env value.
  for (const s of supportServices) {
    for (const arg of s.command || []) {
      if (/\$\{?[A-Za-z_]/.test(String(arg))) {
        const label = `${s.name} command argument "${arg}"`;
        unresolvedPlaceholderKeys.add(label);
        recordPlaceholderVars(arg, label);
      }
    }
  }

  if (supportServices.length > 0) {
    console.log(`\x1b[34mINFO: Generated ${supportServices.length} supporting service(s) declared in docker-compose that the application references but this repository does not build: ${supportServices.map(s => s.name).join(', ')}. Review their images and resources in deploy/helm/values.yaml.\x1b[0m`);
  }
  if (skippedNodeAgents.length > 0) {
    console.warn(`\x1b[33mWARNING: Skipped ${skippedNodeAgents.join(', ')} - these mount the host's docker socket or /proc and /sys, which makes them node-level agents rather than application services. Install them as a DaemonSet (usually via the vendor's own Helm chart) if you want them in the cluster.\x1b[0m`);
  }
  // GitHub reserves the GITHUB_ prefix: such a secret cannot be created.
  const githubReservedKeys = [...envKeysToPass, ...(hasDbPassword ? [finalDbPasswordKey] : [])].filter(k => k && /^GITHUB_/i.test(k));
  if (githubReservedKeys.length > 0) {
    console.warn(`\x1b[33mWARNING: The following secret name(s) start with "GITHUB_", a prefix GitHub reserves for its own secrets - you will NOT be able to create a matching repository secret for: ${githubReservedKeys.join(', ')}. Rename this environment variable in your project.\x1b[0m`);
  }

  if (dbInitFiles) {
    console.log(`\x1b[34mINFO: Carried the database's docker-compose bootstrap scripts into the chart as a ConfigMap: ${Object.keys(dbInitFiles).join(', ')}. They run on the database's FIRST boot only - an existing volume is never re-initialised, so an already-deployed database needs its PVC removed (or the scripts applied by hand) before they take effect.\x1b[0m`);
  }
  if (dbCommandWarnings.length > 0) {
    console.warn(`\x1b[33mWARNING: These database commands in docker-compose use variables that compose fills from .env, so they were not carried: ${dbCommandWarnings.join('; ')}. Write the command with the values themselves under "command:" in flarops.yaml and run "flarops sync".\x1b[0m`);
  }
  if (dbInitWarnings.length > 0) {
    console.warn(`\x1b[33mWARNING: The database mounts these files into /docker-entrypoint-initdb.d in docker-compose, but they could NOT be carried into the cluster: ${dbInitWarnings.join('; ')}. Without them the database will come up with no schema. Apply them yourself, or provide them as a ConfigMap/Secret volume.\x1b[0m`);
  }

  if (supportConfigMapNotes.length > 0) {
    console.log(`\x1b[34mINFO: Carried the docker-compose bind mounts of these supporting services into the chart as ConfigMaps: ${supportConfigMapNotes.join(', ')}.\x1b[0m`);
  }
  if (supportBindMountWarnings.length > 0) {
    console.warn(`\x1b[33mWARNING: These docker-compose bind mounts could NOT be carried into the cluster - provide them as a ConfigMap/Secret volume yourself before deploying: ${supportBindMountWarnings.join('; ')}.\x1b[0m`);
  }

  // A key that qualifies as a secret is never also a plain env value on the same service.
  const dedupeEnvAgainstSecrets = (envObj, secretKeys) => {
    for (const key of secretKeys) {
      if (Object.prototype.hasOwnProperty.call(envObj, key)) delete envObj[key];
    }
  };

  // A container env name carried by an explicit mapping is not also emitted through secretKeys.
  const dropMappedKeysFromSecretKeys = (secretKeys, mappings) => {
    const mapped = new Set((mappings || []).map(m => m.envName));
    for (let i = secretKeys.length - 1; i >= 0; i--) {
      if (mapped.has(secretKeys[i])) secretKeys.splice(i, 1);
    }
  };

  // Plain env is cleaned against both sources before secretKeys is thinned.
  const secretEnvNames = (secretKeys, mappings) =>
    [...secretKeys, ...(mappings || []).map(m => m.envName)];

  dedupeEnvAgainstSecrets(apiEnv, secretEnvNames(apiSecretKeys, apiExtraSecretEnvMappings));
  dedupeEnvAgainstSecrets(frontendEnv, secretEnvNames(frontendSecretKeys, frontendExtraSecretEnvMappings));
  dropMappedKeysFromSecretKeys(apiSecretKeys, apiExtraSecretEnvMappings);
  dropMappedKeysFromSecretKeys(frontendSecretKeys, frontendExtraSecretEnvMappings);
  for (const s of additionalServices) {
    dedupeEnvAgainstSecrets(s.env, secretEnvNames(s.secretKeys, s.extraSecretEnvMappings));
    dropMappedKeysFromSecretKeys(s.secretKeys, s.extraSecretEnvMappings);
  }

  var config = {
    projectName,
    domain,
    dockerRegistry,
    dockerProject,
    dockerRepository,
    registryUser,
    envKeysToPass,
    backendPath: relativeBackendPath,
    frontendPath: relativeFrontendPath,
    hasBackend: backendInfo.hasBackend,
    hasFrontend: frontendInfo.hasFrontend,
    // A backend that embeds a sibling frontend also serves it at "/".
    apiServesFrontend: backendNeedsRootContext && !frontendInfo.hasFrontend,
    apiMigrationStep,
    apiWorkers,
    apiDockerfile: apiDockerfilePath,
    frontendDockerfile: frontendDockerfilePath,
    apiCommand,
    frontendCommand,
    apiBuildArgs,
    frontendBuildArgs,
    awsRegion,

    additionalServices,
    supportServices,
    apiEnv,
    frontendEnv,
    // Kept so sync can say which service reads a misplaced secret.
    apiUsedEnvVars: backendInfo.usedEnvVars || [],
    frontendUsedEnvVars: frontendInfo.usedEnvVars || [],
    apiSecretKeys,
    frontendSecretKeys,
    apiExtraSecretEnvMappings,
    frontendExtraSecretEnvMappings,

    images: {
      api: 'api:latest',
      db: dbInfo.hasDb && dbInfo.hasLocalDockerfile ? 'db:latest' : (dbInfo.hasDb && dbInfo.image ? dbInfo.image : defaultImageFor(dbInfo.dbType)),
      frontend: 'frontend:latest'
    },
    dbCloneSource: '', // Can be updated or prompted in the future
    dbInitFiles,
    hasDb: dbInfo.hasDb,
    apiPorts: backendInfo.ports || [3000],
    frontendPorts: frontendInfo.ports || [80],
    dbType: dbInfo.hasDb ? dbInfo.dbType : null,
    dbPort: dbInfo.hasDb ? dbInfo.port : null,
    dbUser: dbInfo.hasDb ? dbInfo.dbUser : null,
    dbName: dbInfo.hasDb ? dbInfo.dbName : null,
    dbHasLocalDockerfile: dbInfo.hasDb ? dbInfo.hasLocalDockerfile : false,
    dbLocalDockerfile: dbInfo.hasDb ? dbInfo.localDbDockerfile : null,
    dbContext: dbInfo.hasDb ? dbInfo.dbContext : null,
    dbCommand,
    dbPasswordKey: finalDbPasswordKey,
    hasDbPassword,
    dbUrlVars: Object.values(foundDbUrls),
    apiRoutes,
    apiHealthRoute: backendInfo.healthRoute || null,
    apiHealthPort: backendInfo.healthPort || null,
    hasCloudflare: !!(cloudflareApiToken && cloudflareZoneId)
  };

  if (backendInfo.hasBackend && backendInfo.healthRoute) {
    console.log(`Discovered Backend Health Route: ${backendInfo.healthRoute}`);
  }

  const chartYaml = `apiVersion: v2
name: ${projectName}
description: A Helm chart for ${projectName} generated by Flarops
type: application
version: 0.1.0
appVersion: "1.0.0"
`;
  fs.writeFileSync(path.join(helmDir, 'Chart.yaml'), chartYaml);

  const finalDbUser = config.dbUser || defaultUserFor(config.dbType);
  const finalDbName = config.dbName || 'appdb';

  // Resolve the DB user and name once, before any template runs.
  config.dbUser = finalDbUser;
  config.dbName = finalDbName;

  if (config.dbType) {
    const dbUserKeys = ['DATABASE_USER', 'DB_USER', 'POSTGRES_USER', 'MYSQL_USER', 'MARIADB_USER', 'MONGO_INITDB_ROOT_USERNAME'];
    const dbNameKeys = ['DATABASE_DB', 'DB_NAME', 'DATABASE_NAME', 'POSTGRES_DB', 'MYSQL_DATABASE', 'MARIADB_DATABASE', 'MONGO_INITDB_DATABASE'];

    for (const envObj of [apiEnv, ...config.additionalServices.map(s => s.env)]) {
      for (const key of Object.keys(envObj)) {
        if (dbUserKeys.includes(key)) envObj[key] = finalDbUser;
        if (dbNameKeys.includes(key)) envObj[key] = finalDbName;
      }
    }
  }

  const contextObj = { hasLocalhostWarnings: false };

  if (unresolvedPlaceholderKeys.size > 0) {
    console.warn(`\x1b[33mWARNING: These variables still reference a value this repository never defines, so they were left as-is instead of being given an invented one: ${Array.from(unresolvedPlaceholderKeys).join(', ')}. Set their real values (in GitHub Secrets if they are secret, in deploy/helm/values.yaml otherwise) before deploying.\x1b[0m`);

    const sharedGroups = Array.from(placeholderVarToKeys.entries())
      .filter(([, keys]) => keys.size > 1)
      .map(([varName, keys]) => `${varName} -> ${Array.from(keys).join(' = ')}`);
    if (sharedGroups.length > 0) {
      console.warn(`\x1b[33mWARNING: docker-compose read one value into several settings, so these MUST be given the same value or the services will not authenticate to each other: ${sharedGroups.join('; ')}.\x1b[0m`);
    }
  }

  // Several compose services sharing one build context all come back with that context's routes; the
  // backend (or the first service on the context) keeps them.
  {
    const contextOf = (service) => path.resolve(currentDir, service.relativePath || '.');
    const backendContext = config.hasBackend && config.backendPath
      ? path.resolve(currentDir, config.backendPath)
      : null;
    const keeper = new Map();
    for (const s of config.additionalServices) {
      const key = contextOf(s);
      if (!keeper.has(key)) keeper.set(key, s.name);
    }
    for (const s of config.additionalServices) {
      if (!(s.exposedRoutes || []).length) continue;
      const key = contextOf(s);
      const ownedByBackend = backendContext && key === backendContext;
      if (ownedByBackend || keeper.get(key) !== s.name) {
        s.exposedRoutes = [];
      }
    }
  }

  const routeOwners = {};
  if (config.hasBackend) {
    for (const r of config.apiRoutes) (routeOwners[r] = routeOwners[r] || []).push('api');
  }
  for (const s of config.additionalServices) {
    // A service behind the gateway is not a claimant.
    if (s.suppressDirectIngress) continue;
    for (const r of (s.exposedRoutes || [])) (routeOwners[r] = routeOwners[r] || []).push(s.name);
  }
  const conflictingRoutes = Object.entries(routeOwners).filter(([, owners]) => owners.length > 1);
  if (conflictingRoutes.length > 0) {
    for (const s of config.additionalServices) {
      if (s.suppressDirectIngress) continue;
      s.exposedRoutes = s.exposedRoutes.filter(r => !routeOwners[r] || routeOwners[r].length === 1);
    }
    // Conflicting paths are dropped from apiRoutes too, so the warning stays true.
    if (config.hasBackend) {
      config.apiRoutes = config.apiRoutes.filter(r => !routeOwners[r] || routeOwners[r].length === 1);
    }
    console.warn(`\x1b[33mWARNING: Multiple services expose the same Ingress path prefix, which would route ambiguously: ${conflictingRoutes.map(([r, owners]) => `${r} (${owners.join(', ')})`).join('; ')}. These paths were NOT added to the Ingress for the conflicting services - add explicit routing manually if you need them exposed.\x1b[0m`);
  }

  // From here on routes are objects ({ path, stripPrefix }).
  config.apiRoutes = normalizeRoutes(config.apiRoutes);
  for (const s of config.additionalServices || []) {
    s.exposedRoutes = normalizeRoutes(s.exposedRoutes);
  }

  const valuesYaml = require('../../templates/values.yaml.js')(config, contextObj);
  fs.writeFileSync(path.join(helmDir, 'values.yaml'), valuesYaml);

  // What init worked out, recorded for sync (see utils/state.js). Names only, never values.
  require('../../utils/state.js').writeState(currentDir, config);

  const flaropsYamlContent = generateFlaropsYaml(config, {
    apiEnv, frontendEnv, apiSecretKeys, frontendSecretKeys,
    apiExtraSecretEnvMappings, frontendExtraSecretEnvMappings,
    apiBuildArgs, frontendBuildArgs, apiCommand, frontendCommand,
  });
  fs.writeFileSync(path.join(currentDir, 'flarops.yaml'), flaropsYamlContent);
  console.log('Created flarops.yaml');

  // templates/chart.js decides which templates exist; sync renders from the same list.
  const templatesToGenerate = require('../../templates/chart.js')
    .renderChartTemplates(config, helmTemplatesDir);

  templatesToGenerate.forEach(t => fs.writeFileSync(t.file, t.content));

  const githubDir = path.join(currentDir, '.github', 'workflows');
  ensureDir(githubDir, "Created .github/workflows/ directory");

  const otherFilesToGenerate = [
    { file: path.join(githubDir, 'deploy.yml'), content: require('../../templates/deploy.yml.js')(config) },
    { file: path.join(githubDir, 'pr-capsule.yml'), content: require('../../templates/pr-capsule.yml.js')(config) },
    { file: path.join(currentDir, 'werf.yaml'), content: require('../../templates/werf.yaml.js')(config) },
    { file: path.join(currentDir, 'werf-giterminism.yaml'), content: require('../../templates/werf-giterminism.yaml.js')() },
    { file: path.join(currentDir, 'FLAROPS.md'), content: require('../../templates/FLAROPS.md.js')() }
  ];

  otherFilesToGenerate.forEach(f => fs.writeFileSync(f.file, f.content));

  const dashboardSourceDir = path.join(__dirname, '../../dashboard');
  const dashboardDestDir = path.join(deployDir, 'dashboard');
  if (fs.existsSync(dashboardSourceDir)) {
    // Sources only: no locally built binary, no tests, no SQLite runtime state. Comments are stripped.
    fs.cpSync(dashboardSourceDir, dashboardDestDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base === 'dashboard' && src !== dashboardSourceDir && !fs.statSync(src).isDirectory()) return false;
        if (base.endsWith('_test.go')) return false;
        if (/\.db(-wal|-shm)?$/.test(base)) return false;
        return true;
      },
    });
    const { stripGoComments, stripHashComments, stripHtmlComments } = require('../../utils/stripComments.js');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(dashboardDestDir)) {
      const strip = file.endsWith('.go') ? stripGoComments
        : path.basename(file) === 'Dockerfile' ? stripHashComments
          : file.endsWith('.html') ? stripHtmlComments : null;
      if (strip) fs.writeFileSync(file, strip(fs.readFileSync(file, 'utf8')));
    }
  } else {
    console.warn("Dashboard source directory not found: " + dashboardSourceDir);
  }

  if (dashboardPassword) {
    console.log("");
    console.log("\x1b[33m┌───────────────────────────────────────────────────────────────────────────┐\x1b[0m");
    console.log("\x1b[33m│ DASHBOARD LOGIN - this is the only time this password is ever shown.      │\x1b[0m");
    console.log("\x1b[33m└───────────────────────────────────────────────────────────────────────────┘\x1b[0m");
    console.log(`    username: \x1b[1madmin\x1b[0m`);
    console.log(`    password: \x1b[1m${dashboardPassword}\x1b[0m`);
    console.log("");
    console.log("    Store it in your password manager now. Only its PBKDF2 hash is written to");
    console.log("    deploy/.env (as DASHBOARD_PASSWORD_HASH), so it cannot be recovered later -");
    console.log("    delete that line and re-run init to issue a new one.");
    console.log("");
  }

  // Report orphaned templates; removing them is sync's job.
  try {
    const { findOrphanTemplates } = require('./sync.js');
    const found = findOrphanTemplates(currentDir);
    if (found && found.orphans.length > 0) {
      console.warn(`\x1b[33mWARNING: deploy/helm/templates still holds ${found.orphans.length} template(s) for services this project no longer has: ${found.orphans.join(', ')}. They reference values that are gone, and Helm aborts the WHOLE chart on one of them - run "flarops sync" to remove them.\x1b[0m`);
      console.log("");
    }
  } catch (e) { /* best effort - never block a successful generation */ }

  // The secrets to create, printed last so they are still on screen.
  {
    const placeholder = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
    const finalEnv = envIO.read();
    const valueOf = (key) => {
      const m = finalEnv.match(new RegExp('^' + escapeRegex(key) + '=(.*)$', 'm'));
      return m ? m[1].replace(/^["']|["']$/g, '') : '';
    };
    // Infrastructure secrets are read by the workflow directly but are just as required.
    const infrastructureKeys = [
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SSH_PRIVATE_KEY', 'REGISTRY_PASSWORD',
      ...(cloudflareApiToken && cloudflareZoneId ? ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'] : []),
    ];
    const needed = [...infrastructureKeys, ...envKeysToPass.filter(Boolean)]
      .filter((key, i, all) => all.indexOf(key) === i);
    const unmounted = unmountedSecretKeys(config);
    // Only values still blank.
    const stillWithheld = withheldSecretValues.filter(entry => !valueOf(entry.split(' ')[0]));
    if (stillWithheld.length > 0) {
      console.log("");
      console.warn(`\x1b[33mWARNING: These secrets were found, but their values were NOT carried into deploy/.env because they cannot be real production secrets: ${stillWithheld.join(', ')}. Each is still required - give it a real value when you create the GitHub secret.\x1b[0m`);
    }
    if (needed.length > 0) {
      console.log("");
      console.log(`\x1b[36mCreate these ${needed.length} GitHub repository secrets before the first deploy\x1b[0m`);
      console.log(`\x1b[36m(Settings -> Secrets and variables -> Actions). Values are in deploy/.env:\x1b[0m`);
      for (const key of needed) {
        const value = valueOf(key);
        const sameAs = placeholder.exec(value);
        if (sameAs) console.log(`  ${key}  \x1b[33m<- give it the SAME value as ${sameAs[1]}\x1b[0m`);
        else if (infrastructureKeys.includes(key)) console.log(`  ${key}  \x1b[90m(infrastructure)\x1b[0m`);
        else if (unmounted.includes(key)) console.log(`  ${key}  \x1b[33m<- no service reads this; declare it under a service's secretEnvs in flarops.yaml\x1b[0m`);
        else if (!value) console.log(`  ${key}  \x1b[33m<- no value found; you must supply one\x1b[0m`);
        else console.log(`  ${key}`);
      }
      if (lateSecretKeys.length > 0) {
        console.log(`\x1b[36mOf those, ${lateSecretKeys.join(', ')} were added because a service in your stack reads them.\x1b[0m`);
      }
      console.log("");
    }
  }

  console.log("");
  console.log("#############################################################################################");
  console.log("# Flarops has been successfully initialized!                                                #");
  console.log("# Next, follow the instructions in FLAROPS.md to deploy the application for the first time. #");
  console.log("#############################################################################################");
  console.log("");

  if (s3BucketWarning) {
    console.log(s3BucketWarning);
    console.log("");
  }

  // No service answers "/": say so, rather than leave it to a 404 in the browser.
  if (!frontendInfo.frontendPath && !(backendInfo.backendPath && config.apiServesFrontend)) {
    const rootedService = additionalServices.find(s =>
      !s.suppressDirectIngress && normalizeRoutes(s.exposedRoutes).some(r => r.path === '/'));
    if (!rootedService) {
      console.log(`\x1b[36mNOTE: No service in this project serves "/", so ${domain ? `https://${domain}/` : 'the root path'} will return 404 from the ingress controller. Only the paths listed under each service in deploy/helm/values.yaml are routed. This is expected for a backend-only project - add a "/" entry to the intended service's exposedRoutes if something should answer there.\x1b[0m`);
      console.log("");
    }
  }

  if (unresolvedLoopback.length > 0) {
    console.warn(`\x1b[33mWARNING: these variables still point at this machine, which inside a pod is the container itself - Flarops could not tell what they should become: ${unresolvedLoopback.join(', ')}.\x1b[0m`);
    console.warn(`\x1b[33mSet them in flarops.yaml and run "flarops sync". Use a service's name for traffic inside the cluster ("database", "api"), and your project's domain for anything a browser reaches.\x1b[0m`);
    console.log("");
  }
};
