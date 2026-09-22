const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { getDefaultAWSCredentials, ensureAwsCli, handleS3Bucket } = require('../../utils/awsHelper.js');
const { SENSITIVE_REGEX, DB_PASSWORD_REGEX, IGNORED_DIRS } = require('../../utils/constants.js');
const { parseSupportService, extractBuildArgs, materializeBindMounts } = require('../../utils/composeSupport.js');

// Escapes a value for safe interpolation inside a double-quoted HCL string literal.
function hclEscapeString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\$\{/g, '$${')
    .replace(/%\{/g, '%%{');
}

// True if targetPath is filePath itself or lives inside it - used instead of
// raw String.startsWith(), which false-positives on sibling directories that
// share a prefix (e.g. "/repo/api" matching "/repo/api-docs/.env").
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

// sensitiveRegex matches on a bare substring anywhere in the key (by design -
// see its own history), which is exactly right for AUTH_TOKEN or API_KEY but
// also fires on any key that merely NAMES an auth-related endpoint rather
// than holding a credential itself: KEYCLOAK_TOKEN_URI, SERVICES_AUTH_
// SERVICE_URI, SPRING_SECURITY_OAUTH2_..._ISSUER_URI are all just addresses
// (matching "KEY" inside "KEYCLOAK", "TOKEN", and "AUTH" inside "OAUTH2"
// respectively) - routing them into the secrets pipeline demands a GitHub
// secret for something that was never a secret, and leaks nothing worse than
// an internal hostname if left in values.yaml. The variable's suffix - what
// KIND of thing it holds - is a much more reliable signal here than whatever
// service or protocol name happens to appear earlier in it, so a clearly
// location-shaped suffix wins over an incidental sensitive-looking substring.
//
// The same reasoning covers protocol feature flags. "AUTH" makes
// SENSITIVE_REGEX fire, so SPRING_MAIL_PROPERTIES_MAIL_SMTP_AUTH - which only
// ever says whether SMTP authentication is switched on - was demanded as a
// GitHub secret and disappeared from values.yaml, where the setting belongs.
// The decision stays purely a matter of the key's NAME: a protocol name
// immediately before "_AUTH" makes it a switch for that protocol, never a
// credential.
const NON_SENSITIVE_SUFFIX_REGEX = /(_(URI|URL|ENDPOINT|HOST|HOSTNAME|PATH|ADDRESS)|_(SMTP|IMAP|POP3|SSL|TLS|STARTTLS|HTTP|HTTPS|LDAP|SASL|PROXY)_AUTH)$/i;

// Prefixes that are a framework's explicit contract that the value will be
// INLINED into the JavaScript bundle it serves to every browser. Vite
// substitutes import.meta.env.VITE_* at build time, Next.js does the same for
// NEXT_PUBLIC_*, and so on - whatever the rest of the name says, such a value
// is public by construction and cannot be protected by anything Flarops does
// downstream.
//
// Without this, a key like VITE_FRONTEND_FORGE_API_KEY was routed into the
// secrets pipeline purely because its name ends in "_KEY": it was written to
// deploy/.env, demanded as a GitHub secret and mounted from a Kubernetes
// Secret - an elaborate chain protecting a string that ships to every visitor
// in plain text. Worse, it also does not work: the bundle is built long before
// the pod's environment exists, so the value has to reach the image as a build
// argument, not as a runtime secret.
const PUBLIC_CLIENT_ENV_PREFIX_REGEX = /^(VITE|NEXT_PUBLIC|REACT_APP|VUE_APP|NUXT_PUBLIC|GATSBY|EXPO_PUBLIC|PUBLIC|STORYBOOK)_/i;

// The single place a key's name decides whether it is a credential. Kept as
// one function because the answer has to be identical everywhere - the env
// scan, the compose scan and the supporting-service scan all previously
// repeated this expression, and any of them could have drifted.
function isSensitiveKey(key) {
  if (!sensitiveRegex.test(key)) return false;
  if (NON_SENSITIVE_SUFFIX_REGEX.test(key)) return false;
  if (PUBLIC_CLIENT_ENV_PREFIX_REGEX.test(key)) return false;
  return true;
}

const crypto = require('crypto');

// Environment variable names come from the scanned repository, so they can
// legally contain characters that mean something to a regex engine. Building
// a pattern by concatenating one in either matched the wrong thing or threw a
// SyntaxError that aborted the whole generation.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Keys whose value still contains an unresolved ${...} reference after
// sanitizing - reported once at the end of the run so the operator knows
// exactly which values need a real one.
const unresolvedPlaceholderKeys = new Set();

// The same compose variable is routinely read by two different settings that
// then become two different secrets: a broker declares RABBITMQ_DEFAULT_PASS:
// ${RABBITMQ_PASSWORD} while its clients declare SPRING_RABBITMQ_PASSWORD:
// ${RABBITMQ_PASSWORD}. docker-compose expanded both from one shell variable,
// so they could never disagree; as separate GitHub Secrets they can, and the
// only symptom is an authentication failure at runtime. Track which keys came
// from which variable so the operator is told they must match.
const placeholderVarToKeys = new Map();

function recordPlaceholderVars(value, key) {
  const varRegex = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = varRegex.exec(String(value))) !== null) {
    if (!placeholderVarToKeys.has(m[1])) placeholderVarToKeys.set(m[1], new Set());
    placeholderVarToKeys.get(m[1]).add(key);
  }
}

function sanitizeEnvValue(val, key) {
  let cleaned = val;
  const commentIdx = cleaned.indexOf('#');
  if (commentIdx !== -1) {
    cleaned = cleaned.substring(0, commentIdx).trim();
  }
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();

  // A "${OTHER_VAR}" reference embedded in a larger literal (e.g. a URL with
  // an inline "${DB_PASS}") cannot be resolved from inside this repo. It used
  // to be replaced with random hex, which reads as a real value: the operator
  // sees a plausible-looking password/URL in values.yaml and has no way to
  // tell it was invented, while the app fails against it at runtime. Leave
  // the reference verbatim instead - obviously unfilled, greppable, and it
  // never fabricates a credential - and flag the key.
  const varRegex = /\$\{\{?([^}]+)\}\}?|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  if (varRegex.test(cleaned) && key) {
    unresolvedPlaceholderKeys.add(key);
    recordPlaceholderVars(cleaned, key);
  }
  return cleaned;
}


// Like parseSelfReferentialPlaceholder, but for ANY bare variable reference
// (not only a self-referential one) - "${RABBITMQ_PASSWORD}" as the ENTIRE
// value of some OTHER key, e.g. RABBITMQ_DEFAULT_PASS. Returns the variable
// name, or null when the value is anything other than a single bare
// reference (embedded in a larger string, or plain literal text).
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
  // A literal, non-empty default ("${VAR:-realvalue}") is a real value
  // docker-compose would actually use - not something to fabricate a
  // replacement for. Only a bare reference, an empty ":-" default, or a
  // required ":?" counts as genuinely unresolved.
  if (m[2] === ':-' && m[3].trim() !== '') return null;
  return m[1];
}

// The primary backend can BE the project's own API gateway rather than an
// application backend of its own - a hand-rolled or framework reverse proxy
// (Spring Cloud Gateway, express-gateway, a bare nginx in front of it, ...)
// whose entire purpose is enforcing something cross-cutting (JWT validation,
// rate limiting) in front of every other backend service. Detected at
// deliberately higher confidence than "exactly which paths does it proxy" -
// reliably parsing an arbitrary gateway's own routing config across every
// framework isn't realistic, so this only answers "is the primary backend
// itself a gateway at all," and the caller still only suppresses a route for
// a service the gateway demonstrably talks to.
// Names that identify a service as the project's edge: "gateway",
// "api-gateway", "gateway-service", "edge-service", "bff". Matched on a word
// boundary rather than the whole string - the original /^(api-)?gateway$/
// missed "gateway-service", which is how the overwhelming majority of
// microservice repositories spell it.
const GATEWAY_NAME_REGEX = /(^|[-_])(api[-_]?)?(gateway|edge)([-_](service|server|api))?$|^bff([-_].*)?$/i;

// "gateway" is also a domain word. A payment gateway or an SMS gateway is a
// service that talks to an outside provider, not the edge every other service
// sits behind, and treating one as the project's gateway would quietly pull
// its siblings off the Ingress.
const DOMAIN_GATEWAY_PREFIX_REGEX = /^(payment|pay|sms|email|mail|voice|telephony|fax|billing|card|bank|ussd|notification)[-_]/i;

const GATEWAY_DEPENDENCY_MARKERS = [
  { file: 'pom.xml', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'build.gradle', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'build.gradle.kts', pattern: /spring-cloud-starter-gateway|spring-cloud-starter-zuul/i },
  { file: 'package.json', pattern: /express-gateway|http-proxy-middleware|fastify-http-proxy|@nestjs\/microservices/i },
];

// Is THIS service the project's API gateway? Answers only that - deliberately
// not "which paths does it proxy", which cannot be parsed reliably across
// frameworks. Takes every name the service is known by (directory, Kubernetes
// name, docker-compose key), because they routinely disagree.
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

// Detects the extremely common docker-compose "KEY: ${KEY}" / "${KEY:-default}"
// / "${KEY:?message}" declaration, where a compose service simply forwards an
// outer environment variable through under its OWN name. Unlike a variable
// reference embedded inside a larger literal (e.g. a DB URL with an inline
// "${PASSWORD}"), this shape carries no real information about the actual
// value at all - it's a pass-through declaration, not a default. Returns the
// literal default text when the compose author actually wrote one (e.g.
// "${PORT:-8080}"), or null when the true value can only come from outside
// (a bare reference, or ":?" required-with-no-default).
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

function processEnvVariable(key, rawVal, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext, matchedAdditionalServices) {
  if (foundDbUrls[key]) return;
  if (dbPasswordRegex.test(key)) return;

  // A bare "KEY: ${KEY}"-style declaration means the real value is only known
  // externally - Flarops has no business fabricating a random-looking value
  // for it (that random value would otherwise get baked straight into
  // values.yaml as if it were real application config, e.g. a fake "email
  // address" that fails validation at runtime). This only affects what VALUE
  // we use, never which bucket the key lands in - that's still decided
  // solely by sensitiveRegex, exactly as before: PROJECT_NAME/SMTP_HOST/
  // EMAILS_FROM_EMAIL etc. are ordinary (non-secret) config and belong in
  // values.yaml, not suddenly demanding a GitHub secret just because their
  // real value happens to be unknown at generation time.
  const selfRef = parseSelfReferentialPlaceholder(key, rawVal);
  const val = selfRef !== undefined ? (selfRef || '') : sanitizeEnvValue(rawVal, key);

  if (isSensitiveKey(key)) {
    // Dedup by KEY alone, not the full "KEY=VALUE" line - the same secret is
    // routinely declared in more than one place with a different literal
    // value each time (e.g. a placeholder in .env vs. a "${KEY:?...}"
    // interpolation in docker-compose's environment: block). Deduping on the
    // full line lets both slip through, producing a "KEY" that appears twice
    // in the same generated GitHub Actions env: block - which is invalid YAML
    // and fails the whole workflow.
    const keyAlreadyPresent = new RegExp(`(^|\\n)${escapeRegex(key)}=`).test(sensitiveContext.content);
    if (!keyAlreadyPresent) {
      sensitiveContext.content += `${key}=${val}\n`;
    }
  } else {
    if (isBackend) apiEnv[key] = val;
    if (isFrontend) frontendEnv[key] = val;
    if (matchedAdditionalServices && matchedAdditionalServices.length > 0) {
      for (const s of matchedAdditionalServices) {
        s.env[key] = val;
      }
    }
  }
}


// Values here come straight out of the scanned repository, so they can hold a
// quote, a backslash or a newline. Interpolating them raw produced broken (or
// attacker-shaped) YAML - the HCL side already had hclEscapeString for exactly
// this, the YAML side did not. A double-quoted YAML scalar takes the same
// escapes as JSON, so this is the full set that matters here.
function yamlEscapeDoubleQuoted(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function generateEnvString(envObj, context, indent = '    ') {
  if (Object.keys(envObj).length === 0) return `${indent}# KEY: "VALUE"`;
  return Object.entries(envObj).map(([k, v]) => {
    let line = `${indent}${k}: "${yamlEscapeDoubleQuoted(v)}"`;
    if (String(v).toLowerCase().includes('localhost')) {
      context.hasLocalhostWarnings = true;
      line += ` # Change "localhost" to your endpoint service name (api, frontend or db)`;
    }
    return line;
  }).join('\n');
}

module.exports = async function init() {
  const currentDir = process.cwd();
  const gitDir = path.join(currentDir, '.git');

  if (!fs.existsSync(gitDir)) {
    console.error("not a root of git repositoty");
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
    // .terraform.lock.hcl is intentionally NOT ignored: it should be committed
    // so provider versions are pinned and reproducible across CI runs.
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

  // Reusing an existing key is required, not optional: it is the key the
  // already-running EC2 instance trusts, and it is baked into user_data, so
  // regenerating it on every run would both lock the operator out and force
  // the instance to be replaced. But "the file is there" was the ONLY check,
  // which meant a key that arrived with the repository - committed by
  // mistake, or shipped inside a template or fork - was silently adopted as
  // the deploy key for brand new infrastructure. Whoever published that
  // repository would hold the private half.
  //
  // A key's own bytes carry no provenance, but git does: a key the repository
  // tracks came from someone's commit and therefore exists in history (and in
  // every clone), so it must never be used no matter who put it there. A key
  // that is untracked and ignored can only have been written locally.
  const isTrackedByGit = (filePath) => {
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', filePath], { cwd: currentDir, stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
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
    // A private key with a mismatched or missing .pub would authorize a
    // public key nobody holds the private half of - the instance would be
    // unreachable, and only after it had already been provisioned.
    let pairIsConsistent = false;
    try {
      const derivedPublic = execFileSync('ssh-keygen', ['-y', '-f', privateKeyPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      const storedPublic = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8').trim() : '';
      // ssh-keygen -y prints "type base64"; the stored .pub may carry a
      // trailing comment, so compare only the parts that identify the key.
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

  // ssh-keygen sets 0600 on the key itself, but the directory was left at
  // whatever the umask produced.
  try { fs.chmodSync(keysDir, 0o700); } catch (e) { }
  try { fs.chmodSync(privateKeyPath, 0o600); } catch (e) { }

  const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8').trim();

  console.log("\nConfigure your state");



  const registryAnswer = await askQuestion('enter docker registry (default empty for Docker Hub): ');
  const dockerRegistry = registryAnswer.trim();

  let registryUser = '';
  let registryPassword = '';

  const loginRegistry = dockerRegistry || 'docker.io';

  while (true) {
    registryUser = (await askQuestion(`enter username for ${loginRegistry}: `)).trim();
    if (!registryUser) {
      console.log('username is required');
      continue;
    }
    registryPassword = (await askPassword(`enter password for ${loginRegistry}: `)).trim();

    console.log();
    console.log(`Loggining to ${loginRegistry} ...`);
    try {
      execFileSync('docker', ['login', loginRegistry, '-u', registryUser, '--password-stdin'], { input: registryPassword, stdio: ['pipe', 'inherit', 'inherit'] });
      console.log();
      break;
    } catch (err) {
      console.error();
      console.error('Please try again.');
      console.error();
    }
  }

  const domainAnswer = await askQuestion('enter project domain (Press enter if you not using domain name): ');
  const domain = domainAnswer.trim();

  let cloudflareApiToken = '';
  let cloudflareZoneId = '';
  if (domain) {
    const useCloudflare = await askQuestion('Do you want to configure Cloudflare DNS for this domain automatically? (y/n): ');
    if (useCloudflare.trim().toLowerCase() === 'y' || useCloudflare.trim().toLowerCase() === 'yes') {
      cloudflareApiToken = (await askPassword('Enter Cloudflare API Token: ')).trim();
      cloudflareZoneId = (await askQuestion('Enter Cloudflare Zone ID: ')).trim();
    }
  }
  let projectName = path.basename(currentDir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!projectName) projectName = 'flarops-project';
  let awsCredentials = { accessKey: '', secretKey: '' };
  const accessKeyInput = await askQuestion('Enter Project AWS Access Key ID (Press enter to use your default credentials): ');

  if (!accessKeyInput.trim()) {
    const defaultCreds = getDefaultAWSCredentials();
    if (defaultCreds) {
      awsCredentials = defaultCreds;
      console.log('Using default AWS credentials from ~/.aws/credentials');
    } else {
      console.error('Could not find default AWS credentials. Please provide them manually.');
      process.exit(1);
    }
  } else {
    awsCredentials.accessKey = accessKeyInput.trim();
    const secretKeyInput = await askPassword('Enter Project AWS Secret Access Key: ');
    awsCredentials.secretKey = secretKeyInput.trim();
  }

  // One answer, one region. This value used to be hardcoded in three places
  // that disagreed: the CI workflows and the S3 state bucket said us-west-2
  // while Terraform's own aws_region variable defaulted to eu-central-1, so
  // the infrastructure ran in a different region from its own state and from
  // whatever the CI session was configured for. Everything downstream reads
  // this one value.
  const regionAnswer = await askQuestion('enter AWS region (press enter for us-west-2): ');
  const awsRegion = regionAnswer.trim() || 'us-west-2';

  const awsCmd = ensureAwsCli();
  const defaultBucketName = `${projectName}-remote-state`;
  const bucketResult = await handleS3Bucket(awsCmd, defaultBucketName, awsCredentials, askQuestion, awsRegion);
  const remoteStateBucket = bucketResult.bucket;
  let s3BucketWarning = bucketResult.warning;

  const deployDir = path.join(currentDir, 'deploy');
  const terraformDir = path.join(deployDir, 'terraform');


  ensureDir(deployDir, "Created deploy/ directory");
  ensureDir(terraformDir, "Created deploy/terraform/ directory");

  const cloudflareProviderBlock = cloudflareApiToken && cloudflareZoneId ? `
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }` : '';

  const cloudflareProviderConfig = cloudflareApiToken && cloudflareZoneId ? `
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
` : '';

  const mainTfContent = `terraform {
  backend "s3" {
    bucket = "${remoteStateBucket}"
    key    = "terraform.tfstate"
    region = "${awsRegion}"
    # The state file contains the k3s join token and the deploy public key in
    # clear text, so it is encrypted at rest. use_lockfile is S3-native state
    # locking (Terraform 1.10+): without any lock, the three places that run
    # "terraform apply" - a push to main, a PR capsule scaling up, and one
    # scaling down - could interleave and corrupt the state.
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
${cloudflareProviderConfig}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = {
    Name = "\${var.instance_name}-vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "\${var.aws_region}a"
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "random_password" "k3s_token" {
  length  = 32
  special = false
}

resource "aws_security_group" "sg" {
  name        = "\${var.instance_name}-sg"
  description = "Allow SSH, HTTP, and Kubernetes API"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Intra-cluster communication"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Kubernetes API"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-*-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.sg.id]

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
  }

  # The instance metadata service hands out whatever is in user_data - which
  # includes the k3s join token. With IMDSv1 any process that can make an
  # outbound HTTP request could read it, so an SSRF in an application pod was
  # enough to take over the cluster. Requiring a session token (IMDSv2) blocks
  # the plain-GET SSRF shape, and a hop limit of 1 means the response never
  # survives the extra network hop out of a container - only the host itself
  # can reach it. Nothing in user_data queries the metadata service any more,
  # so requiring tokens costs nothing.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi --token \${random_password.k3s_token.result} --tls-san \${aws_eip.eip.public_ip}" sh -
  EOF
  )

  tags = {
    Name = var.instance_name
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

# The Elastic IP is allocated BEFORE the server so its address can be baked
# into the API server certificate via --tls-san above. When the EIP was
# instead declared with "instance = aws_instance.server.id", k3s booted first
# and could only see the temporary auto-assigned public IP; the EIP attached
# afterwards, and every later "terraform output public_ip" returned an address
# the certificate did not cover, so kubectl failed with
# "x509: certificate is valid for <old-ip>". Association is a separate
# resource purely to keep the dependency pointing this way.
resource "aws_eip" "eip" {
  domain = "vpc"
}

resource "aws_eip_association" "eip_assoc" {
  instance_id   = aws_instance.server.id
  allocation_id = aws_eip.eip.id
}

resource "aws_instance" "worker" {
  count                  = var.worker_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.sg.id]

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
  }

  # The instance metadata service hands out whatever is in user_data - which
  # includes the k3s join token. With IMDSv1 any process that can make an
  # outbound HTTP request could read it, so an SSRF in an application pod was
  # enough to take over the cluster. Requiring a session token (IMDSv2) blocks
  # the plain-GET SSRF shape, and a hop limit of 1 means the response never
  # survives the extra network hop out of a container - only the host itself
  # can reach it. Nothing in user_data queries the metadata service any more,
  # so requiring tokens costs nothing.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
    HOSTNAME="\${var.instance_name}-worker-\${count.index + 1}"
    hostnamectl set-hostname $HOSTNAME

    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="agent --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi" K3S_URL=https://\${aws_instance.server.private_ip}:6443 K3S_TOKEN=\${random_password.k3s_token.result} sh -
  EOF
  )

  tags = {
    Name = "\${var.instance_name}-worker-\${count.index + 1}"
    Role = "worker"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}
`;

  const cloudflareResourceBlock = cloudflareApiToken && cloudflareZoneId ? `
resource "cloudflare_record" "domain" {
  count   = var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  value   = aws_eip.eip.public_ip
  type    = "A"
  proxied = true
}

resource "cloudflare_record" "wildcard" {
  count   = var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "*"
  value   = aws_eip.eip.public_ip
  type    = "A"
  proxied = true
}
` : '';

  const mainTfContentEnd = `
output "public_ip" {
  value = aws_eip.eip.public_ip
}

# The instance shape is declared once, in variables.tf, and read back out
# here. CI feeds these outputs into the Helm values (see deploy.yml), which is
# what the dashboard prices the fleet against - so changing the instance type
# means editing exactly one line in variables.tf, not three files that can
# silently disagree about what is actually running.
output "instance_type" {
  value = var.instance_type
}

output "volume_size" {
  value = var.volume_size
}
${cloudflareResourceBlock}`;

  const finalMainTfContent = mainTfContent + mainTfContentEnd;

  const cloudflareVarsBlock = cloudflareApiToken && cloudflareZoneId ? `
variable "cloudflare_api_token" {
  description = "Cloudflare API Token"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID"
  type        = string
  default     = ""
}
` : '';

  const variablesTfContent = `variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "${awsRegion}"
}

variable "instance_name" {
  description = "Name tag for the EC2 instance"
  type        = string
  default     = "${projectName}-instance"
}

variable "worker_count" {
  description = "Number of worker nodes for horizontal scaling"
  type        = number
  default     = 0
}

variable "instance_type" {
  description = "Type of the instance"
  type        = string
  default     = "t3a.medium"
}

variable "volume_size" {
  description = "Size of the root volume in GB"
  type        = number
  default     = 40
}

variable "ssh_public_key" {
  description = "Public SSH key for EC2 instance"
  type        = string
  default     = "${hclEscapeString(publicKey)}"
  sensitive   = true
}
${cloudflareVarsBlock}
variable "domain" {
  description = "Domain Name"
  type        = string
  default     = "${hclEscapeString(domain)}"
}
`;

  const mainTfFile = path.join(terraformDir, 'main.tf');
  writeFileIfNotExists(mainTfFile, finalMainTfContent, "Created deploy/terraform/main.tf", "deploy/terraform/main.tf already exists and is not empty");

  const variablesTfFile = path.join(terraformDir, 'variables.tf');
  const variablesTfExisted = fs.existsSync(variablesTfFile) && fs.readFileSync(variablesTfFile, 'utf8').trim() !== '';
  writeFileIfNotExists(variablesTfFile, variablesTfContent, "Created deploy/terraform/variables.tf", "deploy/terraform/variables.tf already exists");

  // variables.tf is deliberately preserved across re-runs so hand-tuned
  // instance_type/volume_size/aws_region survive - but "domain" is not a
  // tuning knob, it's the answer to a prompt this run just asked again.
  // Leaving the old value behind while values.yaml and both workflows get
  // the new one splits the stack in half: the Ingress serves the new host
  // while Cloudflare's DNS record still points the old one at the cluster,
  // which surfaces only as a 404 from an otherwise healthy deployment.
  if (variablesTfExisted) {
    try {
      const existing = fs.readFileSync(variablesTfFile, 'utf8');
      const domainVarRegex = /(variable\s+"domain"\s*\{[\s\S]*?default\s*=\s*")([^"]*)(")/;
      const found = existing.match(domainVarRegex);
      if (found && found[2] !== domain) {
        fs.writeFileSync(variablesTfFile, existing.replace(domainVarRegex, `$1${hclEscapeString(domain)}$3`));
        console.log(`\x1b[34mINFO: Updated domain in deploy/terraform/variables.tf ("${found[2]}" -> "${domain}"). Re-run the deploy workflow so the DNS record is recreated for the new domain.\x1b[0m`);
      }
    } catch (e) {
      console.warn(`\x1b[33mWARNING: Could not update the domain in deploy/terraform/variables.tf - check its "domain" variable still matches "${domain}".\x1b[0m`);
    }
  }

  // Shares the ecosystem ignore list with the analyzers so the two can't
  // drift apart (this walk used to have its own, much shorter, list).
  const ignoredDirs = new Set([...IGNORED_DIRS, '.git']);

  // A real ".env" is gitignored in almost every project, so a freshly cloned
  // repository usually has none - and matching only that exact name meant
  // such a project contributed no environment variables at all. The example
  // files are the ones that are actually committed; their VALUES are
  // placeholders, but their KEYS are exactly the set the service needs, which
  // is what decides whether a secret gets wired into the container.
  // Ordered by trustworthiness - see the per-directory precedence below.
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
        const stat = fs.statSync(fullPath);
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

  const backendInfo = await analyzeBackend(currentDir);
  const [frontendInfo, dbInfo] = await Promise.all([
    analyzeFrontend(currentDir, backendInfo.backendPath),
    analyzeDatabase(currentDir, backendInfo.backendPath)
  ]);

  let knownPaths = [];
  // A service whose docker-compose build context is the repository root has
  // every sibling service's source underneath it; without excluding them its
  // env scan reports their variables as its own, and the secrets pipeline
  // then wires another service's credentials into this container.
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

  let additionalServices = await analyzeAdditionalServices(currentDir, knownPaths);

  // Resolve naming conflicts
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

  // Initialize env for additional services
  for (const s of additionalServices) {
    s.env = {};
    s.secretKeys = [];
    // s.secretKeys gets fully REASSIGNED later, from a usedEnvVars filter
    // computed only after the whole compose scan finishes - anything pushed
    // onto it during the scan itself (tryWireSharedCredential's direct-push
    // branch, the compose-declaration force-wire) would otherwise be
    // silently discarded the moment that reassignment runs. Collected here
    // instead and merged back in once the reassignment has happened.
    s.forcedSecretKeys = new Set();
  }


  let refactoredEnvKey = null;
  let refactoredRoutes = [];
  if (frontendInfo.frontendPath && backendInfo.ports && backendInfo.ports.length > 0) {
    const doRefactor = await askQuestion('\x1b[36m? \x1b[0mDo you want to automatically refactor hardcoded frontend API URLs to environment variables? (y/n) ');
    if (doRefactor.toLowerCase() === 'y' || doRefactor.toLowerCase() === 'yes') {
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
        console.log(`\x1b[32mSuccessfully refactored ${refactorResult.filesChanged} files to use ${refactoredEnvKey}.\x1b[0m`);
      }
    }
  }

  let foundDbUrls = {};

  if (backendInfo.backendPath && dbInfo.hasDb) {
    let dbRefactorResult = await refactorBackendDbUrl(backendInfo.backendPath, false);

    if (dbRefactorResult && dbRefactorResult.hasHardcoded) {
      const doDbRefactor = await askQuestion('\x1b[36m? \x1b[0mDo you want to automatically refactor hardcoded database URLs in the backend to environment variables? (y/n) ');
      if (doDbRefactor.toLowerCase() === 'y' || doDbRefactor.toLowerCase() === 'yes') {
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

  // Shared with the docker-compose environment: block scan further below -
  // both need to recognize the exact same set of "this is a DB connection
  // string" key names, whichever file they're declared in.
  const dbUrlKeyRegex = /^(DATABASE_URL|DB_URL|MONGO_URI|MONGO_URL|POSTGRES_URL|MYSQL_URL)$/;

  // Within one directory a real .env always beats an example file, so sort by
  // the precedence list and let the first file that declares a key win.
  // Across directories nothing is deduped - backend/.env and frontend/.env
  // legitimately declare the same key (PORT) meaning different things.
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

    const passwordRegex = /^(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)\s*=\s*(.*)$/gm;
    let match;
    while ((match = passwordRegex.exec(content)) !== null) {
      const key = match[1];
      const val = match[2].replace(/^["']|["']$/g, '').trim();
      if (val) {
        foundDbPasswords.push({ file: path.relative(currentDir, file) || '.env', key, value: val });
      }
    }

    const urlRegex = /^(DATABASE_URL|DB_URL|MONGO_URI|MONGO_URL|POSTGRES_URL|MYSQL_URL)\s*=\s*(.*)$/gm;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(content)) !== null) {
      const key = urlMatch[1];
      const val = urlMatch[2].replace(/^["']|["']$/g, '').trim();
      if (val && !foundDbUrls[key]) {
        let query = '';
        try {
          const tempVal = val.replace(/\${([^}]+)}/g, 'BASH_VAR_$1');
          const urlObj = new URL(tempVal);
          query = urlObj.search || '';
        } catch (e) { }
        foundDbUrls[key] = { key, query };
      }
    }

    const dirKey = path.dirname(file);
    if (!keysSeenPerDir.has(dirKey)) keysSeenPerDir.set(dirKey, new Set());
    const seenInDir = keysSeenPerDir.get(dirKey);

    const lines = content.split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
      if (lineMatch) {
        const key = lineMatch[1];
        const val = lineMatch[2];

        // A lower-precedence file in the same directory (e.g. .env.example
        // next to a real .env) must not overwrite the value already taken
        // from the more trustworthy one.
        if (seenInDir.has(key)) continue;
        seenInDir.add(key);

        const handledServices = typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : [];
        if (!tryWireSharedCredential(key, val, isBackend, isFrontend, handledServices)) {
          let sensitiveContext = { content: sensitiveEnvContent };
          processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext, handledServices);
          sensitiveEnvContent = sensitiveContext.content;
        }
      }
    }
  }

  if (refactoredEnvKey) {
    frontendEnv[refactoredEnvKey] = '';
  }

  // Parse docker-compose.yml environment blocks
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  let composeContent = null;
  for (const cf of composeFiles) {
    try {
      composeContent = fs.readFileSync(path.join(currentDir, cf), 'utf8');
      break;
    } catch (e) { }
  }

  // A compose file's OWN infrastructure services - a message broker, a
  // standalone datastore, Keycloak's own bootstrap admin login - declare
  // credentials nothing outside this repository has ever seen or needs to
  // agree on: Flarops creates the container AND injects the value, so it is
  // free to generate that value itself instead of leaving the compose file's
  // "${VAR}" reference unresolved. Every other place in the project that
  // reads the SAME variable - a client's SPRING_RABBITMQ_PASSWORD, a peer
  // service's KC_DB_PASSWORD - gets wired to that one generated secret,
  // rather than being left to independently guess a value that happens to
  // match (docker-compose interpolates both from the same shell variable, so
  // they could never disagree there; as two separately-set GitHub Secrets
  // they very much can, and the only symptom is an authentication failure at
  // runtime).
  //
  // Recognized ONLY by the credential-declaring key on the owning
  // component's own image - never by matching against a value, and never
  // for anything that isn't unambiguously a password. A username sharing the
  // same variable (e.g. KC_DB_USERNAME) is intentionally left alone: unlike
  // a password, Flarops has no free literal to give it that is guaranteed to
  // be a valid identifier for every engine, so it stays a placeholder with a
  // warning that every reference to it must be set to the same value.
  const CREDENTIAL_OWNER_ENV_KEYS = new Set([
    'POSTGRES_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD',
    'MONGO_INITDB_ROOT_PASSWORD', 'RABBITMQ_DEFAULT_PASS', 'KC_BOOTSTRAP_ADMIN_PASSWORD',
  ]);
  // compose variable name (e.g. "RABBITMQ_PASSWORD") -> { secretKey, value }.
  // secretKey is the canonical name this credential is stored and referenced
  // under everywhere: in deploy/.env, as a GitHub secret, and as the key
  // inside the project's Kubernetes Secret.
  const sharedCredentialSecrets = new Map();
  // Consumers discovered during the compose scan, before apiSecretKeys/
  // frontendSecretKeys exist yet (they are computed later from usedEnvVars,
  // which would never catch a name Spring's relaxed binding invents purely
  // by convention and never spells out anywhere in source).
  const apiForcedSecretKeys = new Set();
  const frontendForcedSecretKeys = new Set();
  let apiExtraSecretEnvMappings = [];
  let frontendExtraSecretEnvMappings = [];

  function registerSharedCredential(varName, secretKeyName) {
    if (sharedCredentialSecrets.has(varName)) return sharedCredentialSecrets.get(varName);
    const entry = { secretKey: secretKeyName, value: crypto.randomBytes(16).toString('hex') };
    sharedCredentialSecrets.set(varName, entry);
    return entry;
  }

  // Runs once, before any service's environment is scanned - a consumer can
  // appear earlier in docker-compose.yml than the component whose credential
  // it reads (compose imposes no such ordering), so every owner has to be
  // known up front rather than discovered opportunistically while services
  // are processed in file order.
  async function discoverSharedCredentials() {
    if (!composeContent) return;
    const composeServicesAll = await parseComposeServices(currentDir);
    for (const svc of Object.values(composeServicesAll)) {
      if (!svc.block) continue;
      for (const ownerKey of CREDENTIAL_OWNER_ENV_KEYS) {
        const m = svc.block.match(new RegExp(`^\\s*${ownerKey}:\\s*(.+)$`, 'm'));
        if (!m) continue;
        const bareVar = extractBareVarRef(m[1]);
        if (bareVar) registerSharedCredential(bareVar, ownerKey);
      }
      // Redis has no fixed credential-declaring env var of its own - the
      // password is set via a --requirepass CLI argument instead. The
      // variable's own name becomes the canonical secret key, since there is
      // no engine-provided convention to use instead.
      const cmdMatch = svc.block.match(/--requirepass["',\s]*\$\{?([A-Za-z_][A-Za-z0-9_]*)/);
      if (cmdMatch) registerSharedCredential(cmdMatch[1], cmdMatch[1]);
    }
  }
  await discoverSharedCredentials();

  // Short-circuits the generic env-handling path (processEnvVariable) for a
  // key whose value is a bare reference to an already-discovered shared
  // credential - wiring it straight to that credential's real, generated
  // value instead of leaving "${VAR}" as an unresolved placeholder (or, for
  // a name no source-scanning heuristic would ever recognize as sensitive,
  // not wiring it into the container's environment at all).
  // Returns true when the key/value pair was fully handled here.
  function tryWireSharedCredential(key, rawVal, isBackend, isFrontend, matchedAdditionalServices) {
    if (!isSensitiveKey(key)) return false;
    const bareVar = extractBareVarRef(rawVal);
    if (!bareVar || !sharedCredentialSecrets.has(bareVar)) return false;
    const { secretKey } = sharedCredentialSecrets.get(bareVar);

    if (isBackend) {
      if (key === secretKey) apiForcedSecretKeys.add(key);
      else if (!apiExtraSecretEnvMappings.some(m => m.envName === key)) apiExtraSecretEnvMappings.push({ envName: key, secretKey });
    }
    if (isFrontend) {
      if (key === secretKey) frontendForcedSecretKeys.add(key);
      else if (!frontendExtraSecretEnvMappings.some(m => m.envName === key)) frontendExtraSecretEnvMappings.push({ envName: key, secretKey });
    }
    if (matchedAdditionalServices && matchedAdditionalServices.length > 0) {
      for (const s of matchedAdditionalServices) {
        if (key === secretKey) {
          (s.forcedSecretKeys || (s.forcedSecretKeys = new Set())).add(key);
        } else {
          s.extraSecretEnvMappings = s.extraSecretEnvMappings || [];
          if (!s.extraSecretEnvMappings.some(m => m.envName === key)) s.extraSecretEnvMappings.push({ envName: key, secretKey });
        }
      }
    }
    return true;
  }

  // Maps a docker-compose service key (e.g. "goodreads-config") to the k8s
  // Service name Flarops actually generates for it (e.g. "config-server") -
  // used below to rewrite cross-service hostnames that env values copied
  // verbatim from docker-compose (e.g. SPRING_CONFIG_IMPORT pointing at
  // "goodreads-config:8888"), which would otherwise fail DNS resolution
  // inside the cluster since no Service is ever named after the compose key.
  const composeNameToK8s = {};
  // container_name -> compose service key, so a hostname written as the
  // container name resolves to whatever that service became.
  const composeContainerNames = new Map();
  // Compose services running a database image, resolved to their real
  // generated names once database ownership is settled.
  const composeDbServiceNames = new Set();
  // Every non-app compose service that runs an image, kept with its raw block
  // so a supporting Deployment can be generated for the ones the application
  // actually references (see utils/composeSupport.js).
  const composeSupportCandidates = new Map();

  if (composeContent) {
    const serviceRegex = /^  ([a-zA-Z0-9_-]+):/gm;
    let match;
    const services = [];
    while ((match = serviceRegex.exec(composeContent)) !== null) {
      services.push({ name: match[1], index: match.index });
    }

    for (let i = 0; i < services.length; i++) {
      const start = services[i].index;
      const end = i + 1 < services.length ? services[i + 1].index : composeContent.length;
      const block = composeContent.substring(start, end);

      // A compose service's key often diverges from its source directory name
      // (e.g. "goodreads-svc2" for a directory actually named "service2"),
      // especially once the service normally runs from a pre-built image and
      // keeps its build context only as documentation (commented out). Extract
      // that context - active or commented, single-line or nested - as an
      // alternate identity to match against directory names.
      const buildDirMatch = block.match(/^\s*#?\s*build:\s*\.?\/?([a-zA-Z0-9_-]+)\s*$/m) || block.match(/^\s*#?\s*context:\s*\.?\/?([a-zA-Z0-9_-]+)\s*$/m);
      const buildDirName = buildDirMatch ? buildDirMatch[1] : null;

      // On compose's default network a container answers to BOTH its service
      // key and its container_name, and projects routinely connect using the
      // latter (a compose service "locationdb" with container_name
      // "location-service-mongodb", referenced as
      // "mongodb://...@location-service-mongodb:27017/..."). Only the service
      // key was ever rewritten, so those references survived into the cluster
      // pointing at a name no Service answers to.
      const containerNameMatch = block.match(/^\s*container_name:\s*["']?([a-zA-Z0-9_.-]+)["']?\s*$/m);
      if (containerNameMatch) composeContainerNames.set(containerNameMatch[1], services[i].name);

      let isBackend = ['api', 'backend', 'server'].includes(services[i].name) || (backendInfo.backendPath && (path.basename(backendInfo.backendPath) === services[i].name || (buildDirName && path.basename(backendInfo.backendPath) === buildDirName)));
      let isFrontend = ['frontend', 'client', 'ui', 'web'].includes(services[i].name) || (frontendInfo.frontendPath && (path.basename(frontendInfo.frontendPath) === services[i].name || (buildDirName && path.basename(frontendInfo.frontendPath) === buildDirName)));
      // Match on the sanitized k8s name AND the original directory spelling:
      // init.js rewrites "My_Service" to "my-service" for k8s, so comparing
      // only the sanitized name against a raw compose key never matched and
      // that service lost its entire environment: block. Comparing the
      // compose key sanitized the same way covers the mirror case.
      const sanitizeServiceName = (n) => String(n).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const composeKey = services[i].name;
      let matchedAdditionalServices = additionalServices.filter(s =>
        s.name === composeKey ||
        s.originalName === composeKey ||
        s.name === sanitizeServiceName(composeKey) ||
        (buildDirName && (s.name === buildDirName || s.originalName === buildDirName || s.name === sanitizeServiceName(buildDirName)))
      );

      if (isBackend) composeNameToK8s[services[i].name] = 'api';
      else if (isFrontend) composeNameToK8s[services[i].name] = 'frontend';
      else if (matchedAdditionalServices.length > 0) composeNameToK8s[services[i].name] = matchedAdditionalServices[0].name;
      else {
        // Not an app service. If it runs a database image, which generated
        // object it maps to depends on WHOSE database it is - the project's
        // primary one, or a single microservice's own - and that is only
        // known after the database wiring further below. Record it here and
        // resolve it there (see resolveComposeDatabaseNames).
        //
        // Mapping every database image to the shared "database" (the previous
        // behaviour) is wrong the moment a project runs more than one: a
        // stack with a Keycloak store, an orders store and a products store
        // had all three rewritten to the same hostname, so a service reached
        // for its own database on the right port and found somebody else's.
        const imageMatch = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
        const img = imageMatch ? imageMatch[1] : '';
        if (composeImageDbType(img)) composeDbServiceNames.add(services[i].name);

        // A "profiles:" key makes a compose service opt-in (`--profile
        // quality`), i.e. deliberately not part of the normal stack - those
        // are never generated. Everything else is remembered with its block:
        // whether it becomes a supporting Deployment depends on whether the
        // application actually references it, decided once all the app
        // services' environments are known.
        if (img && !/^\s*profiles:/m.test(block)) {
          composeSupportCandidates.set(services[i].name, block);
        }
      }

      if (!isBackend && !isFrontend && matchedAdditionalServices.length === 0) continue;

      // build.args are consumed at image build time, so they never reach the
      // chart - they have to be handed to werf. Without them a frontend
      // declaring `args: {BUILD_CONFIG: production, API_URL: ...}` was built
      // with its Dockerfile's ARG defaults, i.e. a development bundle
      // pointing at localhost, and no generated manifest could fix that after
      // the fact.
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

      // A service's docker-compose `command:` override supplies CLI
      // arguments its image's ENTRYPOINT needs to actually work (e.g.
      // `-mongoURI mongodb://db:27017/`) - some apps (particularly Go
      // binaries using the stdlib `flag` package) take ALL of their runtime
      // config this way instead of environment variables, invisible to every
      // env-var-based mechanism elsewhere in this generator. Extract it here
      // so it can be rewritten (compose hostnames -> real k8s Service names,
      // same as env values below) and carried into the Deployment as
      // `args:`.
      {
        const commandLines = block.split('\n');
        let inCommand = false;
        let commandIndent = 0;
        const commandArgs = [];
        for (const line of commandLines) {
          if (!inCommand) {
            const m = line.match(/^([ \t]+)command:\s*$/);
            if (m) {
              inCommand = true;
              commandIndent = m[1].length;
            }
            continue;
          }
          if (line.trim() === '') continue;
          const indentMatch = line.match(/^([ \t]*)/);
          const lineIndent = indentMatch ? indentMatch[1].length : 0;
          if (lineIndent <= commandIndent) break; // exit command block
          const itemMatch = line.match(/^\s*-\s*(.+)$/);
          if (itemMatch) {
            const cleaned = itemMatch[1].trim().replace(/\s+#.*$/, '').trim();
            commandArgs.push(cleaned.replace(/^["']|["']$/g, ''));
          }
        }
        if (commandArgs.length > 0) {
          // A CLI-configured app can carry a shared credential the same way
          // Redis does ("--requirepass ${VAR}") - rewrite it to k8s' own
          // $(VAR) interpolation syntax and make sure this service's
          // container actually gets that env var declared, or the
          // interpolation has nothing to substitute from.
          for (let i = 0; i < commandArgs.length; i++) {
            const bareVar = extractBareVarRef(commandArgs[i]);
            if (!bareVar || !sharedCredentialSecrets.has(bareVar)) continue;
            const { secretKey } = sharedCredentialSecrets.get(bareVar);
            commandArgs[i] = `$(${secretKey})`;
            if (isBackend) apiForcedSecretKeys.add(secretKey);
            if (isFrontend) frontendForcedSecretKeys.add(secretKey);
            for (const s of matchedAdditionalServices) {
              (s.forcedSecretKeys || (s.forcedSecretKeys = new Set())).add(secretKey);
            }
          }
          if (isBackend && !apiCommand) apiCommand = commandArgs;
          if (isFrontend && !frontendCommand) frontendCommand = commandArgs;
          for (const s of matchedAdditionalServices) {
            if (!s.command) s.command = commandArgs;
          }
        }
      }

      const lines = block.split('\n');
      let inEnv = false;
      let envIndent = 0;

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
              // Valid list item at same indent
            } else {
              inEnv = false;
              break; // exit environment block
            }
          }

          const envLineMatch = line.match(/^[ \t]+(?:-\s+)?([A-Z_][A-Z0-9_]*)\s*[:=]\s*(.*)$/);
          if (envLineMatch) {
            const key = envLineMatch[1];
            const val = envLineMatch[2];

            // A full DB connection string (DATABASE_URL, MONGO_URI, ...) is
            // only ever recognized as such when it comes from an actual .env
            // file (see the urlRegex scan above) - one declared directly in
            // docker-compose's environment: block (a very common pattern,
            // with no .env file involved at all) fell through to the generic
            // path below instead. That path has no concept of "this is a DB
            // host, rewrite it to the k8s Service name" - it just patches the
            // embedded "${PASSWORD}" placeholder and leaves the original
            // compose hostname (e.g. "db") untouched, which then fails to
            // resolve inside the cluster where the Service is named
            // "database". Registering it in foundDbUrls here makes
            // processEnvVariable skip it below and routes it through the
            // dedicated dbUrlEnvBlock reconstruction in api/deployment.js
            // instead, which rebuilds the URL against the real Service name.
            if (dbUrlKeyRegex.test(key) && !foundDbUrls[key]) {
              const cleanedVal = val.replace(/^["']|["']$/g, '').trim();
              let query = '';
              try {
                const tempVal = cleanedVal.replace(/\$\{([^}]+)\}/g, 'BASH_VAR_$1');
                const urlObj = new URL(tempVal);
                query = urlObj.search || '';
              } catch (e) { }
              foundDbUrls[key] = { key, query };
            }

            // Each additional service can declare its OWN DB connection
            // string (e.g. several peer microservices sharing one database
            // server but each using a differently-named database on it) -
            // the global foundDbUrls dedup above only ever remembers the
            // FIRST service's URL for a given key name, so every other
            // service with the same key (very common - they all tend to call
            // it DATABASE_URL) would otherwise get no connection info at all.
            // Track each service's own database name independently of that
            // dedup so its URL can be rebuilt correctly against whichever
            // Service actually hosts it (see the "shared database" wiring
            // loop later in this function).
            if (dbUrlKeyRegex.test(key) && typeof matchedAdditionalServices !== 'undefined' && matchedAdditionalServices.length > 0) {
              const cleanedVal = val.replace(/^["']|["']$/g, '').trim();
              let ownDbName = null;
              try {
                const tempVal = cleanedVal.replace(/\$\{([^}]+)\}/g, 'BASH_VAR_$1');
                const urlObj = new URL(tempVal);
                ownDbName = urlObj.pathname ? urlObj.pathname.replace(/^\//, '') : null;
              } catch (e) { }
              for (const s of matchedAdditionalServices) {
                s.dbUrlVars = s.dbUrlVars || [];
                if (!s.dbUrlVars.some(v => v.key === key)) {
                  s.dbUrlVars.push({ key, dbName: ownDbName });
                }
              }
            }

            const handledServices = typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : [];
            if (!tryWireSharedCredential(key, val, isBackend, isFrontend, handledServices)) {
              let sensitiveContext = { content: sensitiveEnvContent };
              processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext, handledServices);
              sensitiveEnvContent = sensitiveContext.content;

              // docker-compose's OWN declaration of a sensitive key for THIS
              // service is authoritative proof the running container needs
              // it - unlike a key merely scanned out of some ambient .env
              // file (where an extra independent usedEnvVars signal is a
              // reasonable bar), there is no reason to ALSO require a
              // literal occurrence of the name in source before wiring it,
              // which a framework's relaxed environment-variable binding
              // (Spring chief among them) makes impossible by design.
              // Without this, SPRING_RABBITMQ_PASSWORD/SPRING_MAIL_PASSWORD-
              // shaped keys were demanded as GitHub secrets yet never
              // reached any container at all - broker and SMTP
              // authentication failed outright, silently.
              if (isSensitiveKey(key)) {
                if (isBackend) apiForcedSecretKeys.add(key);
                if (isFrontend) frontendForcedSecretKeys.add(key);
                for (const s of handledServices) {
                  (s.forcedSecretKeys || (s.forcedSecretKeys = new Set())).add(key);
                }
              }
            }
          }
        }
      }
    }
  }

  // Rewriting compose hostnames has to happen AFTER the database wiring
  // below, because which generated object a compose database service maps to
  // (the shared "database", or one service's own "<service>-db") is decided
  // there. Defined here, next to the scan that collected the names; called
  // once everything it depends on is known.
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

  // Rewrite any compose-service hostname references captured above (e.g.
  // SPRING_CONFIG_IMPORT=configserver:http://goodreads-config:8888,
  // BACKEND_HOSTNAME=goodreads-svc1) to the actual k8s Service name Flarops
  // generates for that same service, so cross-service calls resolve inside the
  // cluster instead of failing DNS lookup for a name that only ever existed in
  // docker-compose.
  const rewriteComposeHostnamesIn = (envObj) => {
    const composeNamesFound = Object.keys(composeNameToK8s);
    if (composeNamesFound.length === 0) return;
    for (const k of Object.keys(envObj)) {
      let val = String(envObj[k]);
      let changed = false;
      for (const composeName of composeNamesFound) {
        const k8sName = composeNameToK8s[composeName];
        if (composeName === k8sName) continue;
        const re = new RegExp('\\b' + escapeRegex(composeName) + '\\b', 'g');
        const newVal = val.replace(re, k8sName);
        if (newVal !== val) {
          val = newVal;
          changed = true;
        }
      }
      if (changed) envObj[k] = val;
    }
  };

  // Same rewrite, applied to a command's individual CLI arguments instead of
  // an env map's values - a docker-compose `command:` override often embeds
  // another service's compose name the exact same way an env value would
  // (e.g. "-mongoURI", "mongodb://db:27017/").
  const rewriteComposeHostnamesInList = (list) => {
    if (!Array.isArray(list)) return list;
    const composeNamesFound = Object.keys(composeNameToK8s);
    if (composeNamesFound.length === 0) return list;
    return list.map(item => {
      let val = String(item);
      for (const composeName of composeNamesFound) {
        const k8sName = composeNameToK8s[composeName];
        if (composeName === k8sName) continue;
        const re = new RegExp('\\b' + escapeRegex(composeName) + '\\b', 'g');
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

    // Apply the same "localhost/db-host-name -> k8s service name" rewrite to the
    // api env AND to any additional service's env - previously this only ever
    // touched apiEnv, so a worker/consumer service that also talked to the
    // shared database kept an unreachable "localhost" host with no warning.
    //
    // A *_HOST/*_HOSTNAME-suffixed key is only treated as a database reference
    // when either its key name itself hints at the database (DB_HOST,
    // MONGO_HOST, ...) or its current value already looks like a raw DB
    // endpoint/localhost. Without this check, an unrelated key like
    // BACKEND_HOSTNAME pointing at a sibling microservice (e.g.
    // "goodreads-svc1") would get a fabricated "BACKEND_PORT" set to the
    // database's port - wrong for both the key's meaning and its value.
    const dbRelatedKeyName = /(^|_)(DB|DATABASE|MONGO|MONGODB|MYSQL|POSTGRES|POSTGRESQL|MARIADB|PG)_/i;
    const dbRelatedValue = /(db|database|mysql|postgres|mariadb|mongo|localhost|127\.0\.0\.1)/i;

    // The words that name the project's OWN database engine. Everything else
    // in OTHER_DATASTORE_REGEX is a different piece of infrastructure that
    // merely happens to also be a datastore.
    const PRIMARY_ENGINE_WORDS = {
      postgres: ['postgres', 'postgresql', 'pgsql', 'pg'],
      postgresql: ['postgres', 'postgresql', 'pgsql', 'pg'],
      mysql: ['mysql'],
      mariadb: ['mariadb', 'mysql'],
      mongodb: ['mongo', 'mongodb'],
      redis: ['redis', 'valkey'],
    };

    // A cache, a broker, a search cluster or an identity provider is not the
    // project's database, but its host variable is spelled exactly like one:
    // SPRING_DATA_REDIS_HOST, SPRING_RABBITMQ_HOST, ELASTICSEARCH_HOST. The
    // old value test matched any string merely CONTAINING "redis"/"mongo"/
    // "db", so "SPRING_DATA_REDIS_HOST: cart-redis" was rewritten to the
    // shared "database" - pointing a Redis client straight at the Postgres
    // StatefulSet, on Postgres' port, for a service that then cannot start.
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
        // Belongs to some other component, and nothing about it names the
        // project's own engine - leave it exactly as the project wrote it.
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

    // apiEnv always gets a DATABASE_PORT default even without an explicit host key,
    // matching prior behavior (the api service is assumed to always talk to the DB).
    if (!Object.keys(apiEnv).some(k => /(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i.test(k))) {
      if (!apiEnv.DATABASE_PORT || isNaN(apiEnv.DATABASE_PORT)) apiEnv.DATABASE_PORT = String(defaultDbPort);
    }
    normalizeDbHost(apiEnv);
    for (const s of additionalServices) {
      normalizeDbHost(s.env);
    }
  }

  // dbInfo.port is the authoritative value; this only covers a database whose
  // port was never resolved.
  const defaultDbPortForApi = dbInfo.dbType === 'mongodb' ? 27017 : (dbInfo.dbType === 'mysql' || dbInfo.dbType === 'mariadb' ? 3306 : 5432);
  let inferredKeys = null;
  // Inject detected DB keys into apiEnv if not present
  if (dbInfo.hasDb && backendInfo.hasBackend) {
    inferredKeys = await analyzeBackendForDbKeys(backendInfo.backendPath);

    // Check for lowercase keys and collect them
    const keysToUppercase = [];
    ['hostKey', 'userKey', 'nameKey', 'passwordKey', 'portKey'].forEach(k => {
      const val = inferredKeys[k];
      if (val && val !== val.toUpperCase() && !keysToUppercase.includes(val)) {
        keysToUppercase.push(val);
      }
    });

    if (keysToUppercase.length > 0) {
      const confirmAnswer = await askQuestion(`\x1b[36m? \x1b[0mFound lowercase environment variables in backend code (${keysToUppercase.join(', ')}). Standard convention is UPPERCASE. Do you want to automatically refactor them? (y/n) `);
      const didUppercase = confirmAnswer.trim().toLowerCase() === 'y' || confirmAnswer.trim().toLowerCase() === 'yes';

      if (didUppercase) {
        const { modifiedCount } = await refactorLowercaseEnvVars(backendInfo.backendPath, keysToUppercase, true);
        if (modifiedCount > 0) {
          console.log(`\x1b[34mINFO: Refactored lowercase environment variables to uppercase in ${modifiedCount} backend files.\x1b[0m`);
        }

        // Update inferredKeys with their uppercase counterparts so they are injected properly
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
      apiEnv[inferredKeys.userKey] = dbInfo.dbUser || (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql' ? 'postgres' : 'root');
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database user key: ${inferredKeys.userKey}\x1b[0m`);
    }
    if (inferredKeys.nameKey && !apiEnv[inferredKeys.nameKey]) {
      apiEnv[inferredKeys.nameKey] = dbInfo.dbName || 'appdb';
      console.log(`\x1b[34mINFO: Analyzed backend code and found expected database name key: ${inferredKeys.nameKey}\x1b[0m`);
    }
    // The port was detected alongside the rest but never wired, so a backend
    // reading DB_PORT got nothing while an invented DATABASE_PORT - a name it
    // never reads - was set instead. Wire the real one, and drop the
    // fabricated fallback once the backend's actual naming is known, so the
    // container isn't carrying a second, dead port variable.
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

  if (analyzedKey) {
    finalDbPasswordKey = analyzedKey;
    finalDbPassword = require('crypto').randomBytes(16).toString('hex');
    console.log(`\x1b[34mINFO: Analyzed backend code and found expected database password key: ${finalDbPasswordKey}\x1b[0m`);

    const envMatch = foundDbPasswords.find(p => p.key === finalDbPasswordKey);
    if (envMatch) {
      finalDbPassword = envMatch.value;
      console.log(`\x1b[34mINFO: Found matching password for ${finalDbPasswordKey} in ${envMatch.file}\x1b[0m`);
    } else if (foundDbPasswords.length > 0) {
      // The backend code reads a different key name than what's actually stored in
      // the project's own .env (e.g. code expects DB_PASSWORD, but .env has
      // POSTGRES_PASSWORD). Prefer the real, working password over inventing a
      // fresh random one that the existing database won't accept.
      finalDbPassword = foundDbPasswords[0].value;
      console.warn(`\x1b[33mWARNING: Backend code expects "${finalDbPasswordKey}", but ${foundDbPasswords[0].file} stores the database password under "${foundDbPasswords[0].key}". Using that value for ${finalDbPasswordKey} - please verify this is correct.\x1b[0m`);
    }
  } else if (foundDbPasswords.length > 0) {
    finalDbPasswordKey = foundDbPasswords[0].key;
    finalDbPassword = foundDbPasswords[0].value;
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

  // The dashboard publishes the whole cluster's shape - nodes, pods,
  // namespaces, PVCs and the project's running spend - on a public hostname,
  // so it ships with a login. Only the PBKDF2 hash is persisted anywhere:
  // deploy/.env, the GitHub secret and the Kubernetes Secret all carry the
  // hash, never the password, so reading any of them still leaves an attacker
  // with a 600k-iteration KDF between them and a usable credential.
  //
  // Regenerated only when there isn't one already - a re-run must not silently
  // invalidate the password the operator wrote down after the first run.
  let dashboardPassword = null;
  {
    // envFile is declared further down, so resolve the path directly here.
    const deployEnvPath = path.join(deployDir, '.env');
    const existingEnvForDashboard = fs.existsSync(deployEnvPath) ? fs.readFileSync(deployEnvPath, 'utf8') : '';
    const alreadyProvisioned = /^DASHBOARD_PASSWORD_HASH=/m.test(existingEnvForDashboard) ||
      /^DASHBOARD_PASSWORD_HASH=/m.test(sensitiveEnvContent);
    if (!alreadyProvisioned) {
      // 18 random bytes -> 24 base64url characters, ~144 bits of entropy.
      dashboardPassword = crypto.randomBytes(18).toString('base64url');
      const salt = crypto.randomBytes(16);
      const iterations = 600000;
      const derived = crypto.pbkdf2Sync(dashboardPassword, salt, iterations, 32, 'sha256');
      const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
      // Single-quoted: the encoded hash contains "$" separators, which a shell
      // sourcing this file would otherwise try to expand.
      sensitiveEnvContent += `DASHBOARD_PASSWORD_HASH='pbkdf2-sha256$i=${iterations}$${b64(salt)}$${b64(derived)}'\n`;
    }
  }

  // Every shared credential discovered above (see discoverSharedCredentials)
  // gets ONE line here, under its canonical key - every consumer elsewhere
  // in the project was wired (by tryWireSharedCredential / the support-
  // service loop below) to reference this exact secret, so this is the only
  // place its value needs to be written.
  for (const { secretKey, value } of sharedCredentialSecrets.values()) {
    if (!new RegExp('^' + escapeRegex(secretKey) + '=', 'm').test(sensitiveEnvContent)) {
      sensitiveEnvContent += `${secretKey}="${value}"\n`;
    }
  }

  let envContent = `# These secrets must be saved in Github repository secrets with the same name
AWS_ACCESS_KEY_ID="${awsCredentials.accessKey}"
AWS_SECRET_ACCESS_KEY="${awsCredentials.secretKey}"
SSH_PRIVATE_KEY="${privateKey}"
REGISTRY_PASSWORD="${registryPassword}"
`;

  if (cloudflareApiToken && cloudflareZoneId) {
    envContent += `CLOUDFLARE_API_TOKEN="${cloudflareApiToken}"\n`;
    envContent += `CLOUDFLARE_ZONE_ID="${cloudflareZoneId}"\n`;
  }

  if (sensitiveEnvContent && sensitiveEnvContent.trim()) {
    envContent += `\n# Extracted sensitive variables from project .env files\n${sensitiveEnvContent}`;
  }

  if (finalDbPassword && !new RegExp('^' + escapeRegex(finalDbPasswordKey) + '=', 'm').test(envContent)) {
    envContent += `${finalDbPasswordKey}="${finalDbPassword}"\n`;
  }

  const envFile = path.join(deployDir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, envContent);
    console.log("Created deploy/.env");
  } else {
    let existingEnv = fs.readFileSync(envFile, 'utf8');
    let appended = false;

    if (finalDbPassword && !new RegExp('^' + escapeRegex(finalDbPasswordKey) + '=', 'm').test(existingEnv)) {
      fs.appendFileSync(envFile, `\n${finalDbPasswordKey}="${finalDbPassword}"\n`);
      console.log(`Appended fallback ${finalDbPasswordKey} to deploy/.env`);
      appended = true;
    }

    // Also append any new sensitive variables that aren't already there
    const sensitiveLines = sensitiveEnvContent.split('\n');
    for (const sLine of sensitiveLines) {
      if (sLine.trim()) {
        const key = sLine.split('=')[0];
        if (!new RegExp('^' + escapeRegex(key) + '=', 'm').test(existingEnv)) {
          fs.appendFileSync(envFile, `${sLine}\n`);
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
  } else if (frontendInfo.frontendPath) {
    // A frontend that talks to the backend in ways the heuristics below don't
    // recognize yields an empty array here - previously that silently
    // replaced the safe "/api" default with an empty list, leaving the API
    // completely unrouted in the Ingress. Only override the default when the
    // scan actually found something.
    const discoveredRoutes = await analyzeFrontendRoutes(frontendInfo.frontendPath);
    if (discoveredRoutes.length > 0) {
      apiRoutes = discoveredRoutes;
      console.log(`Discovered API Routes in frontend: ${apiRoutes.join(', ')}`);
    }
  }

  // A route prefix the frontend calls (e.g. "/webapi") can belong to a
  // completely different backend service than the primary "api" - there's no
  // lexical relationship between an arbitrary prefix and whichever service
  // actually owns it, so nothing above can tell them apart. An nginx
  // api-gateway config sitting in front of these services (a common shape in
  // multi-backend projects) states that mapping directly via its
  // location -> proxy_pass port. When one exists, use it to move any
  // misattributed route off apiRoutes and onto the additionalService that
  // actually listens on that port - otherwise the Ingress generated here
  // would send that traffic to the wrong backend entirely.
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

  // The primary backend routing straight to every additionalService's own
  // exposedRoutes, alongside a gateway that exists specifically to sit in
  // front of them, lets a request simply skip the gateway by hitting the
  // longer, more specific Ingress path directly - bypassing whatever
  // cross-cutting concern (JWT validation here, going by api.env's
  // SPRING_SECURITY_OAUTH2_RESOURCESERVER key) the gateway enforces.
  //
  // Suppression is scoped tightly: only an additionalService the gateway's
  // OWN docker-compose declaration demonstrably talks to (a depends_on
  // entry, or its hostname appearing in the gateway's own environment) is
  // affected - never blanket-applied to every additionalService in the
  // project, so a genuinely standalone public service (an unrelated webhook
  // receiver) is untouched.
  if (additionalServices.length > 0) {
    // The gateway is not necessarily the PRIMARY backend. A repository of
    // peer microservices - four Express services, one of them the edge - has
    // no service Flarops would call "api" at all, so keying this on
    // backendInfo.backendPath meant the whole check was dead code exactly
    // where it matters most: every backing service went onto the public
    // Ingress under its own path, and the gateway they sit behind could be
    // skipped by calling them directly.
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
      // A hand-rolled Node/Go gateway routinely hardcodes the upstream
      // hostnames in its source ("http://user-service:3000/users") rather
      // than reading them from the environment, so the env scan alone finds
      // nothing to suppress on exactly the projects that need it most.
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

      // A Eureka-registered gateway (Spring Cloud Gateway's own discovery
      // locator, or an equivalent hand-rolled lookup) never names a sibling
      // service's hostname anywhere in its OWN config at all - it resolves
      // "lb://user-service" against the Eureka registry at request time, so
      // there's no depends_on entry or literal hostname to find. Any
      // additionalService registered in that SAME Eureka is reachable
      // through the gateway by construction, whether or not the gateway's
      // own compose block mentions it by name.
      const EUREKA_KEY_REGEX = /^EUREKA/i;
      const gatewayUsesEureka = Object.keys(gateway.env).some(k => EUREKA_KEY_REGEX.test(k));

      const suppressed = [];
      for (const s of additionalServices) {
        // Never the gateway itself - it is the one thing that has to stay
        // reachable, or nothing in the project is.
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


  const rawRelativeBackendPath = backendInfo.backendPath ? path.relative(currentDir, backendInfo.backendPath) || '.' : null;
  const rawRelativeFrontendPath = frontendInfo.frontendPath ? path.relative(currentDir, frontendInfo.frontendPath) || '.' : null;

  // Some Dockerfiles (e.g. a backend that also builds and embeds a sibling
  // frontend/ into the same image) COPY files that live outside their own
  // service directory. For those, the service directory alone can't be the
  // Docker build context - it has to be the repo root, with the Dockerfile's
  // own path prefixed accordingly (mirrors how Maven reactor modules are
  // handled in templates/werf.yaml.js).
  const backendNeedsRootContext = backendInfo.needsRootContext && rawRelativeBackendPath && rawRelativeBackendPath !== '.';
  const frontendNeedsRootContext = frontendInfo.needsRootContext && rawRelativeFrontendPath && rawRelativeFrontendPath !== '.';

  const relativeBackendPath = backendNeedsRootContext ? '.' : rawRelativeBackendPath;
  const relativeFrontendPath = frontendNeedsRootContext ? '.' : rawRelativeFrontendPath;

  // Any service whose Docker build context ends up being the repo root
  // (including the "backend has no dedicated subdirectory" root-fallback in
  // analyzeBackend, and Maven reactor modules) can accidentally pull
  // Flarops's own generated infrastructure (deploy/) into its build context.
  // At best that bloats the image; at worst - as with
  // deploy/terraform/.terraform.lock.hcl, which CI's "Terraform Init" step
  // creates fresh before anyone has had a chance to commit it - it fails
  // werf's giterminism check outright, since a "." build context is scanned
  // for uncommitted files recursively across the whole repo. Keeping deploy/
  // out of the build context entirely (via .dockerignore, which werf's own
  // build-context inspector also respects) sidesteps the whole class of
  // problem instead of allow-listing individual files as they turn up.
  const anyServiceUsesRootContext = relativeBackendPath === '.' || relativeFrontendPath === '.' ||
    additionalServices.some(s => s.isMavenReactorModule);

  if (anyServiceUsesRootContext) {
    const dockerignoreFile = path.join(currentDir, '.dockerignore');
    const dockerignoreLinesToAdd = ['deploy/'];

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

  // A conventional prestart/migration step (e.g. this project's own
  // backend/scripts/prestart.sh, which runs `alembic upgrade head` then seeds
  // the first superuser - or, for Django, the implicit `manage.py migrate`)
  // needs to run once before the API can serve traffic - otherwise the app
  // starts fine but every DB query 404s/500s against a schema that was never
  // created. Wired as an initContainer in api/deployment.js, using the
  // script's path relative to the backend directory (which is what the
  // container's own WORKDIR is built around).
  const apiMigrationStep = backendInfo.backendPath ? await detectApiMigrationStep(backendInfo.backendPath) : null;
  if (apiMigrationStep) {
    console.log(`\x1b[34mINFO: Detected a migration step in the backend (${apiMigrationStep.command}) - it will run as an initContainer before the API starts.\x1b[0m`);
  }

  // A Dockerfile CMD like `fastapi run --workers 4` or a gunicorn/uvicorn
  // equivalent spawns that many full copies of the process inside the SAME
  // container - a memory limit sized for one process gets it OOMKilled the
  // instant it actually runs several. Scale requests/limits with however many
  // workers the backend's own Dockerfile declares (defaults to 1, matching
  // prior behavior, when none is found).
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
  // Only wire a DB password secret when one was actually found/generated -
  // finalDbPasswordKey defaults to the literal string "DATABASE_PASSWORD" even
  // when no database was detected and nothing was ever generated for it, which
  // previously caused every project (DB or not) to reference a nonexistent
  // secret in CI.
  const hasDbPassword = !!finalDbPassword;
  if (hasDbPassword && finalDbPasswordKey && !envKeysToPass.includes(finalDbPasswordKey)) envKeysToPass.push(finalDbPasswordKey);

  // The chart ALWAYS wires this one (see templates/dashboard.yaml.js), so CI
  // always has to carry it. Registered explicitly rather than left to the scan
  // of envContent above, because that scan only ever sees what THIS run
  // appended: on a re-run the password is deliberately not regenerated, so
  // nothing is appended, the key drops out of the workflow, and the Secret
  // comes up without it - leaving the dashboard pod stuck in
  // CreateContainerConfigError against a secretKeyRef that resolves to
  // nothing. The generated deploy/.env still holds the hash from the first
  // run either way.
  if (!envKeysToPass.includes('DASHBOARD_PASSWORD_HASH')) envKeysToPass.push('DASHBOARD_PASSWORD_HASH');

  const sensitiveKeys = sensitiveEnvContent.split('\n').map(l => l.split('=')[0]).filter(k => k && k.trim());
  if (finalDbPasswordKey && finalDbPassword) sensitiveKeys.push(finalDbPasswordKey);

  const apiSecretKeys = sensitiveKeys.filter(k => backendInfo.usedEnvVars && backendInfo.usedEnvVars.includes(k));
  const frontendSecretKeys = sensitiveKeys.filter(k => frontendInfo.usedEnvVars && frontendInfo.usedEnvVars.includes(k));

  // A shared credential's own key name (RABBITMQ_DEFAULT_PASS, ...) is
  // discovered by tryWireSharedCredential above, independently of whether it
  // happens to also pass the usedEnvVars check that built apiSecretKeys/
  // frontendSecretKeys - Spring's relaxed environment-variable binding in
  // particular means the key is never spelled out anywhere in source for
  // that check to find, yet the running container still needs it declared.
  for (const k of apiForcedSecretKeys) if (!apiSecretKeys.includes(k)) apiSecretKeys.push(k);
  for (const k of frontendForcedSecretKeys) if (!frontendSecretKeys.includes(k)) frontendSecretKeys.push(k);

  for (const s of additionalServices) {
    s.secretKeys = sensitiveKeys.filter(k => s.usedEnvVars && s.usedEnvVars.includes(k));
    for (const k of s.forcedSecretKeys || []) if (!s.secretKeys.includes(k)) s.secretKeys.push(k);
    s.relativePath = path.relative(currentDir, s.path);
    // Wire the DB password secret into this service's container only if its own
    // source code actually reads it - otherwise every additional service would
    // silently get DB credentials it never asked for.
    s.dbPasswordKey = (dbInfo.hasDb && finalDbPasswordKey && s.usedEnvVars && s.usedEnvVars.includes(finalDbPasswordKey)) ? finalDbPasswordKey : null;
  }

  // A project can have more than one backend, each with its own database
  // (e.g. a Java service on MySQL alongside a Node service on MongoDB) -
  // analyzeDatabase() only ever resolves ONE database for the whole project
  // (the one tied to the primary backend above), so any additional service
  // whose database is genuinely different was left with nothing: no
  // StatefulSet, no password, no connection info - it would crash trying to
  // reach a database that was never provisioned.
  for (const s of additionalServices) {
    const serviceDb = await analyzeDatabase(currentDir, s.path);
    const isDistinctDb = serviceDb.hasDb && (!dbInfo.hasDb || serviceDb.dbType !== dbInfo.dbType || serviceDb.image !== dbInfo.image);
    if (!isDistinctDb) continue;

    const serviceUpper = s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    let passwordKeyBase = 'DATABASE_PASSWORD';
    let defaultUser = 'postgres';
    if (serviceDb.dbType === 'postgres' || serviceDb.dbType === 'postgresql') { passwordKeyBase = 'POSTGRES_PASSWORD'; defaultUser = 'postgres'; }
    else if (serviceDb.dbType === 'mysql') { passwordKeyBase = 'MYSQL_ROOT_PASSWORD'; defaultUser = 'root'; }
    else if (serviceDb.dbType === 'mariadb') { passwordKeyBase = 'MARIADB_ROOT_PASSWORD'; defaultUser = 'root'; }
    else if (serviceDb.dbType === 'mongodb') { passwordKeyBase = 'MONGO_INITDB_ROOT_PASSWORD'; defaultUser = 'root'; }
    const passwordKey = `${serviceUpper}_${passwordKeyBase}`;
    const password = crypto.randomBytes(16).toString('hex');

    const existingEnvContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    if (!new RegExp('^' + escapeRegex(passwordKey) + '=', 'm').test(existingEnvContent)) {
      fs.appendFileSync(envFile, `\n${passwordKey}="${password}"\n`);
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

    // Spring Data MongoDB binds SPRING_DATA_MONGODB_URI from the environment
    // the same way. Registering it as a dbUrlVar makes the deployment template
    // build the URL against this service's own generated database, with the
    // password pulled in through K8s $(VAR) interpolation instead of sitting
    // in plain text - and drops the compose value, which named a container
    // that does not exist in the cluster and credentials the generated
    // database was never created with.
    const isSpringMongo = await detectSpringDataMongoConfig(s.path);
    if (isSpringMongo && serviceDb.dbType === 'mongodb') {
      delete s.env['SPRING_DATA_MONGODB_URI'];
      s.dbUrlVars = s.dbUrlVars || [];
      if (!s.dbUrlVars.some(v => v.key === 'SPRING_DATA_MONGODB_URI')) {
        s.dbUrlVars.push({ key: 'SPRING_DATA_MONGODB_URI', dbName: s.db.name });
      }
      continue;
    }

    const isSpring = await detectSpringDatasourceConfig(s.path);
    if (isSpring) {
      // Spring Boot's relaxed env-var binding picks these up automatically -
      // no source code change needed, unlike every other framework Flarops
      // supports.
      const jdbcScheme = serviceDb.dbType === 'mysql' ? 'mysql' : (serviceDb.dbType === 'mariadb' ? 'mariadb' : 'postgresql');
      s.env['SPRING_DATASOURCE_URL'] = `jdbc:${jdbcScheme}://${s.name}-db:${serviceDb.port}/${s.db.name}`;
      s.env['SPRING_DATASOURCE_USERNAME'] = s.db.user;
      s.springDatasourcePasswordSecretKey = passwordKey;
      // The compose-declaration force-wire above (or a plain usedEnvVars
      // match) may have ALSO added the literal "SPRING_DATASOURCE_PASSWORD"
      // to s.secretKeys, pointing at a secret of that exact name - which no
      // longer exists (it was just superseded and pruned above). Rendering
      // BOTH that entry and springDatasourcePasswordBlock would put two
      // "- name: SPRING_DATASOURCE_PASSWORD" entries in the same container,
      // which Kubernetes' server-side apply rejects outright.
      const rawIdx = s.secretKeys.indexOf('SPRING_DATASOURCE_PASSWORD');
      if (rawIdx !== -1) s.secretKeys.splice(rawIdx, 1);

      // Spring's own relaxed environment-variable binding means
      // SPRING_DATASOURCE_PASSWORD is never spelled out anywhere in this
      // service's source for the usedEnvVars check to catch - yet the
      // earlier compose/.env scan, seeing a plain PASSWORD-shaped key name,
      // unconditionally captured it and demanded it as a GitHub secret. The
      // container never actually reads a secret under that name - it reads
      // ${passwordKey} instead, wired above - so continuing to demand it
      // would mislead an operator who dutifully sets it into believing it
      // configures anything.
      const deadKeyIdx = envKeysToPass.indexOf('SPRING_DATASOURCE_PASSWORD');
      if (deadKeyIdx !== -1 && 'SPRING_DATASOURCE_PASSWORD' !== passwordKey) {
        envKeysToPass.splice(deadKeyIdx, 1);
        try {
          const currentEnvContent = fs.readFileSync(envFile, 'utf8');
          const withoutDeadLine = currentEnvContent.replace(/^SPRING_DATASOURCE_PASSWORD=.*\n?/m, '');
          if (withoutDeadLine !== currentEnvContent) {
            fs.writeFileSync(envFile, withoutDeadLine);
            fs.chmodSync(envFile, 0o600);
          }
        } catch (e) { /* deploy/.env not written yet or already clean */ }
        console.log(`\x1b[34mINFO: "SPRING_DATASOURCE_PASSWORD" was found in the project but Spring's relaxed environment-variable binding means the container never reads a secret under that exact name - it uses ${passwordKey} instead (wired automatically). Removed it from the required GitHub secrets and deploy/.env.\x1b[0m`);
      }
    } else {
      // Generic fallback for JS/TS services: rewrite a hardcoded connection
      // string in the service's own source to read from an env var, the same
      // mechanism already used for the primary backend.
      const dbUrlRefactorResult = await refactorBackendDbUrl(s.path, true);
      if (dbUrlRefactorResult && dbUrlRefactorResult.discoveredVars.length > 0) {
        s.dbUrlVars = s.dbUrlVars || [];
        for (const key of dbUrlRefactorResult.discoveredVars) {
          if (!s.dbUrlVars.some(v => v.key === key)) s.dbUrlVars.push({ key });
        }
      }
    }
  }

  // Several peer services can share ONE physical database server while each
  // using its own differently-named database on it (e.g. three microservices
  // all pointing DATABASE_URL at the same Mongo instance, each with its own
  // db name) - the compose scan above already recorded each such service's
  // own db name in s.dbUrlVars. Those services never went through the
  // "distinct database" loop above (their db image matches the project's
  // shared primary database), so they still need to be wired against that
  // shared database - otherwise, same as an unwired distinct database, they'd
  // have a DATABASE_URL-shaped variable name but no value, and fail to
  // connect entirely.
  if (dbInfo.hasDb) {
    for (const s of additionalServices) {
      if (s.db || !Array.isArray(s.dbUrlVars) || s.dbUrlVars.length === 0) continue;

      const ownCompose = await analyzeServiceDatabaseFromCompose(currentDir, s.path);
      s.db = {
        type: dbInfo.dbType,
        image: dbInfo.image,
        port: dbInfo.port,
        user: dbInfo.dbUser || (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql' ? 'postgres' : 'root'),
        name: null, // each dbUrlVars entry below carries its own db name
        passwordKey: finalDbPasswordKey,
        shared: true,
        // This service reaches the SHARED database, but docker-compose named
        // that container something of its own - record it so hostnames written
        // against the compose name still get rewritten to "database".
        composeServiceName: (ownCompose && ownCompose.composeServiceName) || dbInfo.composeServiceName || null
      };
      if (finalDbPasswordKey && !s.secretKeys.includes(finalDbPasswordKey)) {
        s.secretKeys.push(finalDbPasswordKey);
      }
    }
  }

  // A service can also read its database connection as separate HOST/USER/
  // PASSWORD/NAME env vars instead of one combined URL (e.g. process.env.
  // DB_HOST, .DB_PASS, ...) - analyzeBackendForDbKeys already detects this
  // exact shape for the primary backend above, but never got checked for any
  // other service. A peer microservice sharing the project's database needs
  // its host rewritten to the real k8s Service name and its password wired
  // just as much as the primary backend does - skip only services that got
  // their own dedicated database above, which are wired through their own
  // mechanism instead.
  if (dbInfo.hasDb) {
    const isUpper = (k) => !!k && k === k.toUpperCase();
    for (const s of additionalServices) {
      if (s.db && !s.db.shared) continue;

      const svcKeys = await analyzeBackendForDbKeys(s.path);
      if (isUpper(svcKeys.hostKey) && !s.env[svcKeys.hostKey]) {
        s.env[svcKeys.hostKey] = 'database';
      }
      if (isUpper(svcKeys.userKey) && !s.env[svcKeys.userKey]) {
        s.env[svcKeys.userKey] = dbInfo.dbUser || (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql' ? 'postgres' : 'root');
      }
      if (isUpper(svcKeys.passwordKey) && finalDbPasswordKey) {
        if (svcKeys.passwordKey === finalDbPasswordKey) {
          if (!s.secretKeys.includes(finalDbPasswordKey)) s.secretKeys.push(finalDbPasswordKey);
        } else {
          // The app's own password env var name doesn't match the shared
          // secret's key name - map one to the other directly instead of
          // renaming either (a secretKeyRef's container-side name and its
          // key in the Secret are independent).
          s.extraSecretEnvMappings = s.extraSecretEnvMappings || [];
          if (!s.extraSecretEnvMappings.some(m => m.envName === svcKeys.passwordKey)) {
            s.extraSecretEnvMappings.push({ envName: svcKeys.passwordKey, secretKey: finalDbPasswordKey });
          }
        }
      }
    }
  }

  // A container's env list is assembled from several independent sources
  // (the plain env map, the secretKeys list, and - for api - a dedicated
  // dbPasswordKey/dbUrlVars block), each populated by its own detection path
  // that doesn't know about the others. When the same variable name qualifies
  // for more than one of them (e.g. a backend reading a DB_PASSWORD-style
  // name is both "sensitive" and "the DB password key"), Kubernetes rejects
  // the resulting Deployment outright ("duplicate entries for key") - or,
  // worse, if a secret's real value ever ended up on the plain-env side
  // instead, it would render as plaintext directly into values.yaml. Rather
  // than special-casing each new collision as it's discovered (this is the
  // second one found this way - the first was api's own dbPasswordKey vs.
  // apiSecretKeys), enforce the invariant once, generally: whenever a key
  // qualifies as a secret, it must never also appear as a plain env value for
  // that same service - the secret reference always wins. (The function that
  // does this is dedupeEnvAgainstSecrets, further down: everything between
  // here and it has to run first, because it is what decides which keys are
  // secrets and which services carry them.)

  // A build arg's value often comes from the developer's own shell
  // ("API_URL: ${API_URL}"), which resolves to nothing here. Baking the
  // literal "${API_URL}" into the image would be worse than the Dockerfile's
  // default, so an unresolved arg is dropped - except for the frontend's API
  // base URL, which Flarops does know: the application is served from one
  // domain and reaches its own API through the same ingress.
  const droppedBuildArgs = [];
  const rewrittenBuildArgs = [];

  // A build arg is COMPILED INTO the image, so unlike a values.yaml entry
  // there is no later opportunity to correct it - the "change localhost to a
  // service name" warning that covers the runtime environment cannot help
  // here, because by the time anyone reads it the bundle already contains the
  // developer's own machine. A loopback address is never reachable from a
  // pod, so rewrite it to the address the application is actually served on.
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
  // A framework's public env prefix is a promise that the value is INLINED
  // into the bundle at build time - which is why isSensitiveKey refuses to
  // treat one as a credential. The same fact makes it useless as a runtime
  // container variable: the bundle was compiled long before the pod existed,
  // so a VITE_/NEXT_PUBLIC_/... value that only reaches values.yaml reaches
  // nothing at all. Pass it to the image build as well, which is the only
  // point at which it can still take effect. It is left in the container's
  // environment too, for the frameworks that also read it at runtime (a
  // Next.js server, an SSR entrypoint).
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

  // Everything the rewrite depends on is settled by now: which compose
  // service became the shared database, which ones became a single service's
  // own database, and which app service each compose key maps to.
  resolveComposeDatabaseNames();

  // Third-party components the application genuinely depends on but that no
  // directory of this repository builds - a cache, a broker, an identity
  // provider, an infrastructure component's own database. They used to be
  // dropped on the floor while every hostname referring to them survived in
  // the generated environment, producing a chart that renders cleanly and a
  // deployment where those services crash-loop against a name nothing serves.
  //
  // Only services the application actually reaches are generated: a compose
  // file's dev-only extras (a database GUI, a local SMTP inbox viewer, an
  // observability stack) are referenced by nothing and stay out of the
  // cluster, exactly as before.
  const supportServices = [];
  const supportBindMountWarnings = [];
  const supportConfigMapNotes = [];
  const skippedNodeAgents = [];
  if (composeSupportCandidates.size > 0) {
    const generatedNames = new Set(Object.keys(composeNameToK8s));
    // The per-service database StatefulSets are named "<service>-db" and were
    // never registered as taken, so a compose service spelled that way would
    // collide with one.
    for (const s of additionalServices) {
      if (s.db && !s.db.shared) usedNames.add(`${s.name}-db`);
    }
    const composeGraph = await parseComposeServices(currentDir);

    // A compose name counts as referenced when it appears in an env value or
    // a command argument of something Flarops generates, or when a generated
    // app service names it in depends_on.
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

    // Transitive: a supporting service can itself need another one (Keycloak
    // needs its own Postgres), so keep resolving until nothing new is pulled in.
    const chosen = new Set();
    let added = true;
    while (added) {
      added = false;
      const haystack = referenceHaystack();
      for (const [composeName, block] of composeSupportCandidates) {
        if (chosen.has(composeName)) continue;
        // Already generated as the shared database or a service's own database.
        if (generatedNames.has(composeName)) continue;

        const referencedInValues = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegex(composeName)}([^A-Za-z0-9_.-]|$)`).test(haystack);
        const neededByChosen = Array.from(chosen).some(c =>
          ((composeGraph[c] && composeGraph[c].dependsOn) || []).includes(composeName));
        if (!referencedInValues && !dependedOnByApp.has(composeName) && !neededByChosen) continue;

        const parsed = parseSupportService(composeName, block);
        if (!parsed) continue;
        if (usedNames.has(parsed.name)) continue; // name already taken by a generated object

        // A node-level agent instruments the machine, not the application.
        // Generated as a Deployment its hostPath mounts are dropped, so it
        // would start, observe nothing, and demand an API-key secret for the
        // privilege. It belongs in the cluster as a DaemonSet the operator
        // installs deliberately - usually through the vendor's own chart.
        if (parsed.isNodeAgent) {
          skippedNodeAgents.push(composeName);
          chosen.add(composeName);
          continue;
        }

        // Route this component's own secrets through the project Secret, the
        // same way every application secret is handled - a broker's password
        // has no business sitting in a committed values.yaml.
        parsed.secretKeys = [];
        parsed.extraSecretEnvMappings = [];

        // Redis has no fixed credential-declaring env var of its own - the
        // password is set via a --requirepass CLI argument instead, already
        // discovered by discoverSharedCredentials. Rewrite the argument to
        // k8s' own $(VAR) interpolation syntax and make sure this container
        // actually declares that env var, or the interpolation has nothing
        // to substitute from.
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

          // A credential this component OWNS (its own POSTGRES_PASSWORD,
          // RABBITMQ_DEFAULT_PASS, ...) or independently references from
          // ANOTHER already-discovered owner (Keycloak's KC_DB_PASSWORD
          // reading its own Postgres support service's password) - either
          // way, discoverSharedCredentials already generated the real value
          // and deploy/.env already carries it under its canonical key, so
          // this container just needs wiring to that same secret.
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
            // deploy/.env has already been written by this point, so append
            // the way the per-service database passwords above do.
            const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
            if (!new RegExp('^' + escapeRegex(key) + '=', 'm').test(existing)) {
              fs.appendFileSync(envFile, `${key}=${sanitizeEnvValue(rawVal, key)}\n`);
            }
            if (!envKeysToPass.includes(key)) envKeysToPass.push(key);
          } else {
            parsed.env[key] = sanitizeEnvValue(rawVal, key);
          }
        }
        if (parsed.extraSecretEnvMappings.length === 0) delete parsed.extraSecretEnvMappings;

        // Carry the component's own configuration into the cluster as a
        // ConfigMap instead of dropping it. Without this an nginx declared as
        // the project's API gateway came up with none of its routes - a
        // perfectly healthy pod serving the stock welcome page.
        if (parsed.bindMounts.length > 0) {
          const carried = materializeBindMounts(fs, path, currentDir, parsed.bindMounts);
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

  // Every container_name inherits the mapping of the service it belongs to.
  for (const [containerName, serviceKey] of composeContainerNames) {
    const target = composeNameToK8s[serviceKey];
    if (target && !composeNameToK8s[containerName]) composeNameToK8s[containerName] = target;
  }

  rewriteComposeHostnames();
  // Supporting services carry compose hostnames of their own (Keycloak's
  // KC_DB_URL points at its Postgres by compose name), so they go through the
  // same rewrite.
  for (const s of supportServices) {
    const wrapper = { env: s.env };
    rewriteComposeHostnamesIn(wrapper.env);
    if (s.command) s.command = rewriteComposeHostnamesInList(s.command);
  }

  // A command argument can carry an unresolved reference just as an env value
  // can ("--requirepass ${REDIS_PASSWORD}"), and it would otherwise be set to
  // that literal string inside the container with nothing to say so.
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
  // GitHub reserves the GITHUB_ prefix for its own automatic secrets/vars - a repo
  // secret with that name literally cannot be created, so it would silently
  // resolve to something unrelated (or nothing) in CI. Warn loudly instead of
  // generating a workflow that can never actually receive this value.
  //
  // Checked HERE rather than where envKeysToPass is first assembled: the
  // per-service database passwords and the supporting services' own secrets
  // are appended after that point, so a reserved name arriving from one of
  // them was never examined.
  const githubReservedKeys = [...envKeysToPass, ...(hasDbPassword ? [finalDbPasswordKey] : [])].filter(k => k && /^GITHUB_/i.test(k));
  if (githubReservedKeys.length > 0) {
    console.warn(`\x1b[33mWARNING: The following secret name(s) start with "GITHUB_", a prefix GitHub reserves for its own secrets - you will NOT be able to create a matching repository secret for: ${githubReservedKeys.join(', ')}. Rename this environment variable in your project.\x1b[0m`);
  }

  if (supportConfigMapNotes.length > 0) {
    console.log(`\x1b[34mINFO: Carried the docker-compose bind mounts of these supporting services into the chart as ConfigMaps: ${supportConfigMapNotes.join(', ')}.\x1b[0m`);
  }
  if (supportBindMountWarnings.length > 0) {
    console.warn(`\x1b[33mWARNING: These docker-compose bind mounts could NOT be carried into the cluster - provide them as a ConfigMap/Secret volume yourself before deploying: ${supportBindMountWarnings.join('; ')}.\x1b[0m`);
  }

  // Enforces the invariant set out above: a key that qualifies as a secret is
  // referenced through the Secret and never also written as a plain env value
  // on the same service.
  const dedupeEnvAgainstSecrets = (envObj, secretKeys) => {
    for (const key of secretKeys) {
      if (Object.prototype.hasOwnProperty.call(envObj, key)) delete envObj[key];
    }
  };
  dedupeEnvAgainstSecrets(apiEnv, apiSecretKeys);
  dedupeEnvAgainstSecrets(frontendEnv, frontendSecretKeys);
  for (const s of additionalServices) {
    dedupeEnvAgainstSecrets(s.env, s.secretKeys);
  }

  var config = {
    projectName,
    domain,
    dockerRegistry,
    registryUser,
    envKeysToPass,
    backendPath: relativeBackendPath,
    frontendPath: relativeFrontendPath,
    hasBackend: backendInfo.hasBackend,
    hasFrontend: frontendInfo.hasFrontend,
    // A backend whose Dockerfile needs the repo root as build context because
    // it COPYs a sibling frontend/ into its own image (see
    // dockerfileNeedsRootContext) is, in every project seen so far, also the
    // container that serves that built frontend at "/" itself (e.g. FastAPI's
    // app.mount("/", StaticFiles(...))) - there is no separate frontend
    // service to route to. Without this, ingress generation only ever adds a
    // catch-all "/" rule when .hasFrontend is true, so the embedded frontend
    // ends up completely unreachable: nothing routes root path traffic
    // anywhere.
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
    apiSecretKeys,
    frontendSecretKeys,
    apiExtraSecretEnvMappings,
    frontendExtraSecretEnvMappings,

    images: {
      api: 'api:latest',
      db: dbInfo.hasDb && dbInfo.hasLocalDockerfile ? 'db:latest' : (dbInfo.hasDb && dbInfo.image ? dbInfo.image : 'postgres:15-alpine'),
      frontend: 'frontend:latest'
    },
    dbCloneSource: '', // Can be updated or prompted in the future
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

  // Write Chart.yaml
  const chartYaml = `apiVersion: v2
name: ${projectName}
description: A Helm chart for ${projectName} generated by Flarops
type: application
version: 0.1.0
appVersion: "1.0.0"
`;
  fs.writeFileSync(path.join(helmDir, 'Chart.yaml'), chartYaml);

  let defaultDbUser = 'postgres';
  if (config.dbType === 'mysql') defaultDbUser = 'mysql';
  else if (config.dbType === 'mongodb') defaultDbUser = 'root';

  const finalDbUser = config.dbUser || defaultDbUser;
  const finalDbName = config.dbName || 'appdb';

  // Every consumer must resolve the DB user identically. values.yaml resolved
  // it here (engine-specific default), while pr-capsule.yml.js independently
  // fell back to "root" - so a postgres project with no detected user created
  // the database as "postgres" but ran its PR-capsule clone as
  // "pg_dump -U root", which fails. Write the resolved values back onto config
  // before any template runs, so there is exactly one answer.
  config.dbUser = finalDbUser;
  config.dbName = finalDbName;

  if (config.dbType) {
    const dbUserKeys = ['DATABASE_USER', 'DB_USER', 'POSTGRES_USER', 'MYSQL_USER', 'MARIADB_USER', 'MONGO_INITDB_ROOT_USERNAME'];
    const dbNameKeys = ['DATABASE_DB', 'DB_NAME', 'DATABASE_NAME', 'POSTGRES_DB', 'MYSQL_DATABASE', 'MARIADB_DATABASE', 'MONGO_INITDB_DATABASE'];

    // Apply to apiEnv and to any additional service's env - a service that also
    // reads the DB user/name (copied from a shared root .env) previously kept
    // whatever raw value was in the source project instead of the resolved one.
    for (const envObj of [apiEnv, ...config.additionalServices.map(s => s.env)]) {
      for (const key of Object.keys(envObj)) {
        if (dbUserKeys.includes(key)) envObj[key] = finalDbUser;
        if (dbNameKeys.includes(key)) envObj[key] = finalDbName;
      }
    }
  }

  let hasLocalhostWarnings = false;
  let contextObj = { hasLocalhostWarnings };

  let apiEnvString = generateEnvString(apiEnv, contextObj);
  let frontendEnvString = generateEnvString(frontendEnv, contextObj);

  hasLocalhostWarnings = contextObj.hasLocalhostWarnings;

  if (unresolvedPlaceholderKeys.size > 0) {
    console.warn(`\x1b[33mWARNING: These variables still reference a value this repository never defines, so they were left as-is instead of being given an invented one: ${Array.from(unresolvedPlaceholderKeys).join(', ')}. Set their real values (in GitHub Secrets if they are secret, in deploy/helm/values.yaml otherwise) before deploying.\x1b[0m`);

    const sharedGroups = Array.from(placeholderVarToKeys.entries())
      .filter(([, keys]) => keys.size > 1)
      .map(([varName, keys]) => `${varName} -> ${Array.from(keys).join(' = ')}`);
    if (sharedGroups.length > 0) {
      console.warn(`\x1b[33mWARNING: docker-compose read one value into several settings, so these MUST be given the same value or the services will not authenticate to each other: ${sharedGroups.join('; ')}.\x1b[0m`);
    }
  }

  // If two or more additional services independently expose the same Ingress
  // root path (e.g. both have some endpoint under /db/...), routing all of
  // them to that one path is ambiguous - Traefik would pick one arbitrarily.
  // Drop the conflicting prefix from every claimant rather than silently
  // generating an Ingress with duplicate, undefined-priority rules.
  const routeOwners = {};
  if (config.hasBackend) {
    for (const r of config.apiRoutes) (routeOwners[r] = routeOwners[r] || []).push('api');
  }
  for (const s of config.additionalServices) {
    for (const r of (s.exposedRoutes || [])) (routeOwners[r] = routeOwners[r] || []).push(s.name);
  }
  const conflictingRoutes = Object.entries(routeOwners).filter(([, owners]) => owners.length > 1);
  if (conflictingRoutes.length > 0) {
    for (const s of config.additionalServices) {
      s.exposedRoutes = (s.exposedRoutes || []).filter(r => !routeOwners[r] || routeOwners[r].length === 1);
    }
    // The warning below says a conflicting path was dropped for every listed
    // owner, including "api" when it's one of them - but api's routes are
    // never filtered above (apiRoutes isn't an additionalServices entry), so
    // api would otherwise silently keep serving that path while the message
    // claims it doesn't. Strip it from apiRoutes too so the message is true
    // and the ambiguity is actually resolved, not just half-resolved.
    if (config.hasBackend) {
      config.apiRoutes = config.apiRoutes.filter(r => !routeOwners[r] || routeOwners[r].length === 1);
    }
    console.warn(`\x1b[33mWARNING: Multiple services expose the same Ingress path prefix, which would route ambiguously: ${conflictingRoutes.map(([r, owners]) => `${r} (${owners.join(', ')})`).join('; ')}. These paths were NOT added to the Ingress for the conflicting services - add explicit routing manually if you need them exposed.\x1b[0m`);
  }

  // Write values.yaml

  let additionalServicesYaml = '';
  if (config.additionalServices && config.additionalServices.length > 0) {
    additionalServicesYaml = 'additionalServices:\n';
    for (const s of config.additionalServices) {
      additionalServicesYaml += `  - name: ${s.name}
    image: ${s.name}:latest
    env:
${generateEnvString(s.env, contextObj, '      ')}
    secretKeys:
${s.secretKeys.map(k => '      - ' + k).join('\n')}
    ports:
${s.ports.map(p => '      - ' + p).join('\n')}
    replicas: 1
    healthRoute: ${s.healthRoute ? '"' + s.healthRoute + '"' : 'null'}
    healthPort: ${s.healthPort || 'null'}
    exposedRoutes: ${s.exposedRoutes && s.exposedRoutes.length > 0 ? '[' + s.exposedRoutes.map(r => '"' + r + '"').join(', ') + ']' : '[]'}
    # false when this project's own API gateway already covers these routes
    # (see detectApiIsGateway) - set to true to also expose them directly,
    # bypassing the gateway.
    exposeDirectly: ${s.suppressDirectIngress ? 'false' : 'true'}
${s.command ? `    command:\n${s.command.map(a => '      - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}${(s.db && !s.db.shared) ? `    db:
      type: "${yamlEscapeDoubleQuoted(s.db.type)}"
      image: "${yamlEscapeDoubleQuoted(s.db.image)}"
      port: ${s.db.port}
      user: "${yamlEscapeDoubleQuoted(s.db.user)}"
      name: "${yamlEscapeDoubleQuoted(s.db.name)}"
      replicas: 1
      storage: "10Gi"
` : ''}`;
    }
  }

  // Supporting services (see utils/composeSupport.js) carry a literal image
  // from docker-compose rather than one werf builds, so the image belongs in
  // values.yaml where it can be re-pinned without regenerating anything.
  let supportServicesYaml = '';
  if (config.supportServices && config.supportServices.length > 0) {
    supportServicesYaml = '\n# Third-party components declared in docker-compose that the application\n' +
      '# references but this repository does not build. Images are pinned exactly as\n' +
      '# docker-compose declared them.\nsupportServices:\n';
    for (const s of config.supportServices) {
      supportServicesYaml += `  - name: ${s.name}
    image: "${yamlEscapeDoubleQuoted(s.image)}"
    replicas: 1
    env:
${generateEnvString(s.env, contextObj, '      ')}
    secretKeys:
${(s.secretKeys || []).map(k => '      - ' + k).join('\n')}
    ports:
${(s.ports || []).map(p => '      - ' + p).join('\n')}
${(s.volumes && s.volumes.length > 0) ? `    storage: "5Gi"\n` : ''}${s.command ? `    command:\n${s.command.map(a => '      - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}`;
    }
    supportServicesYaml += 'supportServicesIndices:\n';
    for (let i = 0; i < config.supportServices.length; i++) {
      supportServicesYaml += `  ${config.supportServices[i].name}: ${i}\n`;
    }
  }

  let valuesYaml = `projectName: ${projectName}
domain: "${domain}"
hasBackend: ${config.hasBackend}
hasFrontend: ${config.hasFrontend}
apiServesFrontend: ${!!config.apiServesFrontend}
images:
${config.hasBackend ? `  api: ${config.images.api}` : ''}
  db: ${config.images.db}
${config.hasFrontend ? `  frontend: ${config.images.frontend}` : ''}
dbCloneSource: "${config.dbCloneSource}"
dbType: ${config.dbType ? '"' + config.dbType + '"' : 'null'}
dbPort: ${config.dbPort || 'null'}
database:
  user: "${yamlEscapeDoubleQuoted(finalDbUser)}"
  password: null
  name: "${yamlEscapeDoubleQuoted(finalDbName)}"
  replicas: 1
  storage: "10Gi"
  env:
    # KEY: "VALUE"
${config.hasBackend ? `api:
  replicas: 1
  healthRoute: ${config.apiHealthRoute ? '"' + config.apiHealthRoute + '"' : 'null'}
  healthPort: ${config.apiHealthPort || 'null'}
  secretKeys:
${config.apiSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${apiEnvString}
${config.apiCommand ? `  command:\n${config.apiCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}apiPorts:
${config.apiPorts.map(p => '  - ' + p).join('\n')}` : ''}
${config.hasFrontend ? `frontend:
  replicas: 1
  secretKeys:
${config.frontendSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${frontendEnvString}
${config.frontendCommand ? `  command:\n${config.frontendCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}frontendPorts:
${config.frontendPorts.map(p => '  - ' + p).join('\n')}` : ''}
${additionalServicesYaml}${supportServicesYaml}
apiRoutes:
${config.apiRoutes.map(p => '  - "' + p + '"').join('\n')}

# instanceType and volumeSize are deliberately NOT set here. They are declared
# once, in deploy/terraform/variables.tf, and CI reads them back out of
# Terraform's outputs into these keys at deploy time (see the workflow's
# buildValuesScript). Writing them here as well would mean three copies of the
# same fact - chart, Terraform and dashboard - that drift the first time
# someone resizes the fleet and only edits one of them.
#
# region is the exception: Terraform cannot be its source, because the region
# has to be known before Terraform can initialise its own S3 backend.
aws:
  region: "${yamlEscapeDoubleQuoted(awsRegion)}"
  instanceType: null
  volumeSize: null
dashboard:
  replicas: 1
  storage: "1Gi"
# Populated by CI from the registry credentials (see the workflow's
# buildValuesScript) so private images can be pulled. Left null here on
# purpose - nothing secret belongs in a committed file.
imagePullSecret: null
`;

  if (config.additionalServices && config.additionalServices.length > 0) {
    valuesYaml += 'additionalServicesIndices:\n';
    for (let i = 0; i < config.additionalServices.length; i++) {
      valuesYaml += `  ${config.additionalServices[i].name}: ${i}\n`;
    }
  }

  fs.writeFileSync(path.join(helmDir, 'values.yaml'), valuesYaml);


  const ingressTemplate = require('../../templates/01-ingress.js');
  const secretTemplate = require('../../templates/secret.js');
  const dbDeploymentTemplate = require('../../templates/database/deployment.js');
  const dbServiceTemplate = require('../../templates/database/service.js');
  const apiDeploymentTemplate = require('../../templates/api/deployment.js');
  const apiServiceTemplate = require('../../templates/api/service.js');
  const frontendDeploymentTemplate = require('../../templates/frontend/deployment.js');
  const frontendServiceTemplate = require('../../templates/frontend/service.js');
  const dashboardYamlTemplate = require('../../templates/dashboard.yaml.js');


  const genericDeploymentTemplate = require('../../templates/generic/deployment.js');
  const genericServiceTemplate = require('../../templates/generic/service.js');
  const genericDatabaseTemplate = require('../../templates/generic/database.js');
  const supportServiceTemplate = require('../../templates/generic/support.js');

  const templatesToGenerate = [
    { file: path.join(helmTemplatesDir, '01-ingress.yaml'), content: ingressTemplate(config) },
    { file: path.join(helmTemplatesDir, '_helpers.tpl'), content: require('../../templates/helpers.tpl.js')() },
    { file: path.join(helmTemplatesDir, 'secret.yaml'), content: secretTemplate() },
    { file: path.join(helmTemplatesDir, 'registry-secret.yaml'), content: require('../../templates/registry-secret.js')(config) },
    { file: path.join(helmTemplatesDir, 'dashboard.yaml'), content: dashboardYamlTemplate(config) }
  ];

  if (config.hasBackend) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'api.yaml'), content: apiServiceTemplate() + '\n---\n' + apiDeploymentTemplate(config) });
  }
  if (config.hasFrontend) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'frontend.yaml'), content: frontendServiceTemplate() + '\n---\n' + frontendDeploymentTemplate(config) });
  }

  if (config.supportServices && config.supportServices.length > 0) {
    for (const s of config.supportServices) {
      templatesToGenerate.push({ file: path.join(helmTemplatesDir, `support-${s.name}.yaml`), content: supportServiceTemplate(s) });
    }
  }

  if (config.additionalServices && config.additionalServices.length > 0) {
    for (const s of config.additionalServices) {
      let serviceContent = genericServiceTemplate(s) + '\n---\n' + genericDeploymentTemplate(s);
      templatesToGenerate.push({ file: path.join(helmTemplatesDir, `${s.name}.yaml`), content: serviceContent });
      if (s.db && !s.db.shared) {
        templatesToGenerate.push({ file: path.join(helmTemplatesDir, `${s.name}-db.yaml`), content: genericDatabaseTemplate(s) });
      }
    }
  }


  if (config.dbType) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'database.yaml'), content: dbServiceTemplate(config) + '\n---\n' + dbDeploymentTemplate(config) });
  }

  templatesToGenerate.forEach(t => fs.writeFileSync(t.file, t.content));

  // Generate GitHub Actions pipeline
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

  // Copy dashboard folder if it doesn't exist
  const dashboardSourceDir = path.join(__dirname, '../../dashboard');
  const dashboardDestDir = path.join(deployDir, 'dashboard');
  if (fs.existsSync(dashboardSourceDir)) {
    // Copy the SOURCES only. The flarops checkout usually also holds a
    // locally-built "dashboard" binary (gitignored there, but not in the
    // project being generated) - copying it committed a ~60MB stale
    // executable into the user's repository and shipped it into the Docker
    // build context. Test files are development artifacts of this repo too.
    fs.cpSync(dashboardSourceDir, dashboardDestDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base === 'dashboard' && src !== dashboardSourceDir && !fs.statSync(src).isDirectory()) return false;
        if (base.endsWith('_test.go')) return false;
        return true;
      },
    });
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

  // Nothing in the chart answers "/". The Ingress only ever gets a "/" path
  // from a frontend, or from a backend that serves one; a project of pure
  // backend services has no catch-all, so the domain's root falls through to
  // the ingress controller and returns 404. That is the correct outcome - a
  // root handler is not something to invent - but it is worth saying at
  // generation time rather than leaving it to be discovered in a browser.
  if (!frontendInfo.frontendPath && !(backendInfo.backendPath && config.apiServesFrontend)) {
    const rootedService = additionalServices.find(s =>
      !s.suppressDirectIngress && Array.isArray(s.exposedRoutes) && s.exposedRoutes.includes('/'));
    if (!rootedService) {
      console.log(`\x1b[36mNOTE: No service in this project serves "/", so https://${domain}/ will return 404 from the ingress controller. Only the paths listed under each service in deploy/helm/values.yaml are routed. This is expected for a backend-only project - add a "/" entry to the intended service's exposedRoutes if something should answer there.\x1b[0m`);
      console.log("");
    }
  }

  if (hasLocalhostWarnings) {
    console.log(`\x1b[36mATTENTION: We found "localhost" references in your environment variables.\x1b[0m`);
    console.log(`\x1b[36mPlease open deploy/helm/values.yaml and change "localhost" to the appropriate service name (e.g. "api", "frontend", or "database") so containers can communicate properly in Kubernetes!\x1b[0m`);
    console.log("");
  }
};
