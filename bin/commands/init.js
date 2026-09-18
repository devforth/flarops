const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { getDefaultAWSCredentials, ensureAwsCli, handleS3Bucket } = require('../../utils/awsHelper.js');
const { SENSITIVE_REGEX, DB_PASSWORD_REGEX } = require('../../utils/constants.js');

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
const NON_SENSITIVE_SUFFIX_REGEX = /_(URI|URL|ENDPOINT|HOST|HOSTNAME|PATH|ADDRESS)$/i;

const crypto = require('crypto');
const generatedVarsCache = {};

function sanitizeEnvValue(val) {
  let cleaned = val;
  const commentIdx = cleaned.indexOf('#');
  if (commentIdx !== -1) {
    cleaned = cleaned.substring(0, commentIdx).trim();
  }
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();

  const varRegex = /\$\{\{?([^}]+)\}\}?|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
  cleaned = cleaned.replace(varRegex, (match, g1, g2) => {
    const varName = (g1 || g2).trim();
    if (!generatedVarsCache[varName]) {
      generatedVarsCache[varName] = crypto.randomBytes(8).toString('hex');
    }
    return generatedVarsCache[varName];
  });
  return cleaned;
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
  const val = selfRef !== undefined ? (selfRef || '') : sanitizeEnvValue(rawVal);

  if (sensitiveRegex.test(key) && !NON_SENSITIVE_SUFFIX_REGEX.test(key)) {
    // Dedup by KEY alone, not the full "KEY=VALUE" line - the same secret is
    // routinely declared in more than one place with a different literal
    // value each time (e.g. a placeholder in .env vs. a "${KEY:?...}"
    // interpolation in docker-compose's environment: block). Deduping on the
    // full line lets both slip through, producing a "KEY" that appears twice
    // in the same generated GitHub Actions env: block - which is invalid YAML
    // and fails the whole workflow.
    const keyAlreadyPresent = new RegExp(`(^|\\n)${key}=`).test(sensitiveContext.content);
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


function generateEnvString(envObj, context, indent = '    ') {
  if (Object.keys(envObj).length === 0) return `${indent}# KEY: "VALUE"`;
  return Object.entries(envObj).map(([k, v]) => {
    let line = `${indent}${k}: "${v}"`;
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

  const keysDir = path.join(currentDir, '.keys');
  ensureDir(keysDir, "Created .keys/ directory");

  const privateKeyPath = path.join(keysDir, 'deploy_rsa');
  const publicKeyPath = path.join(keysDir, 'deploy_rsa.pub');
  if (!fs.existsSync(privateKeyPath)) {
    console.log("Generating SSH keys in .keys/ ...");
    execFileSync('ssh-keygen', ['-t', 'rsa', '-b', '4096', '-f', privateKeyPath, '-q', '-N', '']);
  }

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

  const awsCmd = ensureAwsCli();
  const defaultBucketName = `${projectName}-remote-state`;
  const bucketResult = await handleS3Bucket(awsCmd, defaultBucketName, awsCredentials, askQuestion);
  const remoteStateBucket = bucketResult.bucket;
  let s3BucketWarning = bucketResult.warning;

  const deployDir = path.join(currentDir, 'deploy');
  const terraformDir = path.join(deployDir, 'terraform');

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
    region = "us-west-2"
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

  user_data = sensitive(<<-EOF
    #!/bin/bash
    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi --token \${random_password.k3s_token.result} --tls-san $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)" sh -
  EOF
  )

  tags = {
    Name = var.instance_name
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "eip" {
  instance = aws_instance.server.id
  domain   = "vpc"
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
  default     = "eu-central-1"
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
  writeFileIfNotExists(variablesTfFile, variablesTfContent, "Created deploy/terraform/variables.tf", "deploy/terraform/variables.tf already exists");

  const ignoredDirs = new Set(['node_modules', '.git', 'deploy', 'dist', 'build', '.keys']);
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
        } else if (file === '.env') {
          fileList.push(fullPath);
        }
      } catch (e) { }
    }
    return fileList;
  }

  const { analyzeBackend, analyzeFrontend, analyzeAdditionalServices, extractUsedEnvVars, detectApiMigrationStep, detectApiWorkerCount, findRoutePortMapFromGatewayConfig } = require('../../utils/analyzer');
  const { analyzeDatabase, analyzeBackendForDbPasswordKey, analyzeBackendForDbKeys, detectSpringDatasourceConfig } = require('../../utils/dbAnalyzer');
  const { analyzeFrontendRoutes } = require('../../utils/routeAnalyzer');
  const { refactorFrontendEnv, refactorBackendDbUrl, refactorNginxConf, refactorLowercaseEnvVars } = require('../../utils/envRefactor');

  const backendInfo = await analyzeBackend(currentDir);
  const [frontendInfo, dbInfo] = await Promise.all([
    analyzeFrontend(currentDir, backendInfo.backendPath),
    analyzeDatabase(currentDir, backendInfo.backendPath)
  ]);

  let knownPaths = [];
  if (backendInfo.backendPath) {
    knownPaths.push(backendInfo.backendPath);
    backendInfo.usedEnvVars = await extractUsedEnvVars(backendInfo.backendPath);
  }
  if (frontendInfo.frontendPath) {
    knownPaths.push(frontendInfo.frontendPath);
    frontendInfo.usedEnvVars = await extractUsedEnvVars(frontendInfo.frontendPath);
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

  const envFiles = findEnvFiles(currentDir);
  let foundDbPasswords = [];

  let apiEnv = {};
  let frontendEnv = {};
  let apiCommand = null;
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

    const lines = content.split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
      if (lineMatch) {
        const key = lineMatch[1];
        const val = lineMatch[2];

        let sensitiveContext = { content: sensitiveEnvContent };
        processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext, typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : []);
        sensitiveEnvContent = sensitiveContext.content;
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

  // Maps a docker-compose service key (e.g. "goodreads-config") to the k8s
  // Service name Flarops actually generates for it (e.g. "config-server") -
  // used below to rewrite cross-service hostnames that env values copied
  // verbatim from docker-compose (e.g. SPRING_CONFIG_IMPORT pointing at
  // "goodreads-config:8888"), which would otherwise fail DNS resolution
  // inside the cluster since no Service is ever named after the compose key.
  const composeNameToK8s = {};

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

      let isBackend = ['api', 'backend', 'server'].includes(services[i].name) || (backendInfo.backendPath && (path.basename(backendInfo.backendPath) === services[i].name || (buildDirName && path.basename(backendInfo.backendPath) === buildDirName)));
      let isFrontend = ['frontend', 'client', 'ui', 'web'].includes(services[i].name) || (frontendInfo.frontendPath && (path.basename(frontendInfo.frontendPath) === services[i].name || (buildDirName && path.basename(frontendInfo.frontendPath) === buildDirName)));
      let matchedAdditionalServices = additionalServices.filter(s => s.name === services[i].name || (buildDirName && s.name === buildDirName));

      if (isBackend) composeNameToK8s[services[i].name] = 'api';
      else if (isFrontend) composeNameToK8s[services[i].name] = 'frontend';
      else if (matchedAdditionalServices.length > 0) composeNameToK8s[services[i].name] = matchedAdditionalServices[0].name;
      else {
        // Not an app service at all - but if its own image is a known
        // database engine (e.g. compose's "db: image: mongo:4.2.23"), it's
        // the project's primary database, generated as the "database"
        // StatefulSet/Service - hostnames pointing at it (e.g. a CLI flag or
        // env value hardcoding "mongodb://db:27017/") need the same rewrite
        // as any other cross-service reference below.
        const imageMatch = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
        const img = imageMatch ? imageMatch[1].toLowerCase() : '';
        if (dbInfo.hasDb && /postgres|mysql|mariadb|mongo/.test(img)) {
          composeNameToK8s[services[i].name] = 'database';
        }
      }

      if (!isBackend && !isFrontend && matchedAdditionalServices.length === 0) continue;

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

            let sensitiveContext = { content: sensitiveEnvContent };
            processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext, typeof matchedAdditionalServices !== 'undefined' ? matchedAdditionalServices : []);
            sensitiveEnvContent = sensitiveContext.content;
          }
        }
      }
    }
  }

  // Rewrite any compose-service hostname references captured above (e.g.
  // SPRING_CONFIG_IMPORT=configserver:http://goodreads-config:8888,
  // BACKEND_HOSTNAME=goodreads-svc1) to the actual k8s Service name Flarops
  // generates for that same service, so cross-service calls resolve inside the
  // cluster instead of failing DNS lookup for a name that only ever existed in
  // docker-compose.
  {
    const composeNamesFound = Object.keys(composeNameToK8s);
    if (composeNamesFound.length > 0) {
      const rewriteComposeNames = (envObj) => {
        for (const k of Object.keys(envObj)) {
          let val = String(envObj[k]);
          let changed = false;
          for (const composeName of composeNamesFound) {
            const k8sName = composeNameToK8s[composeName];
            if (composeName === k8sName) continue;
            const re = new RegExp('\\b' + composeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
            const newVal = val.replace(re, k8sName);
            if (newVal !== val) {
              val = newVal;
              changed = true;
            }
          }
          if (changed) envObj[k] = val;
        }
      };
      rewriteComposeNames(apiEnv);
      rewriteComposeNames(frontendEnv);
      for (const s of additionalServices) rewriteComposeNames(s.env);

      // Same rewrite, applied to a command's individual CLI arguments instead
      // of an env map's values - a docker-compose `command:` override often
      // embeds another service's compose name the exact same way an env
      // value would (e.g. "-mongoURI", "mongodb://db:27017/").
      const rewriteComposeNamesInList = (list) => {
        if (!Array.isArray(list)) return list;
        return list.map(item => {
          let val = String(item);
          for (const composeName of composeNamesFound) {
            const k8sName = composeNameToK8s[composeName];
            if (composeName === k8sName) continue;
            const re = new RegExp('\\b' + composeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
            val = val.replace(re, k8sName);
          }
          return val;
        });
      };
      if (apiCommand) apiCommand = rewriteComposeNamesInList(apiCommand);
      if (frontendCommand) frontendCommand = rewriteComposeNamesInList(frontendCommand);
      for (const s of additionalServices) {
        if (s.command) s.command = rewriteComposeNamesInList(s.command);
      }
    }
  }

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
    const dbRelatedKeyName = /^(DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_|POSTGRESQL_|MARIADB_|REDIS_|PG_)/i;
    const dbRelatedValue = /(db|database|mysql|postgres|mariadb|mongo|redis|localhost|127\.0\.0\.1)/i;
    const normalizeDbHost = (envObj) => {
      const hostKeys = Object.keys(envObj).filter(k => /(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i.test(k));
      if (hostKeys.length === 0) return;

      let dbPrefix = null;
      for (const k of hostKeys) {
        const val = String(envObj[k]).toLowerCase();
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

  if (finalDbPassword && !new RegExp('^' + finalDbPasswordKey + '=', 'm').test(envContent)) {
    envContent += `${finalDbPasswordKey}="${finalDbPassword}"\n`;
  }

  const envFile = path.join(deployDir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, envContent);
    console.log("Created deploy/.env");
  } else {
    let existingEnv = fs.readFileSync(envFile, 'utf8');
    let appended = false;

    if (finalDbPassword && !new RegExp('^' + finalDbPasswordKey + '=', 'm').test(existingEnv)) {
      fs.appendFileSync(envFile, `\n${finalDbPasswordKey}="${finalDbPassword}"\n`);
      console.log(`Appended fallback ${finalDbPasswordKey} to deploy/.env`);
      appended = true;
    }

    // Also append any new sensitive variables that aren't already there
    const sensitiveLines = sensitiveEnvContent.split('\\n');
    for (const sLine of sensitiveLines) {
      if (sLine.trim()) {
        const key = sLine.split('=')[0];
        if (!new RegExp('^' + key + '=', 'm').test(existingEnv)) {
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

  // GitHub reserves the GITHUB_ prefix for its own automatic secrets/vars - a repo
  // secret with that name literally cannot be created, so it would silently
  // resolve to something unrelated (or nothing) in CI. Warn loudly instead of
  // generating a workflow that can never actually receive this value.
  const githubReservedKeys = [...envKeysToPass, ...(hasDbPassword ? [finalDbPasswordKey] : [])].filter(k => k && /^GITHUB_/i.test(k));
  if (githubReservedKeys.length > 0) {
    console.warn(`\x1b[33mWARNING: The following secret name(s) start with "GITHUB_", a prefix GitHub reserves for its own secrets - you will NOT be able to create a matching repository secret for: ${githubReservedKeys.join(', ')}. Rename this environment variable in your project.\x1b[0m`);
  }

  const sensitiveKeys = sensitiveEnvContent.split('\n').map(l => l.split('=')[0]).filter(k => k && k.trim());
  if (finalDbPasswordKey && finalDbPassword) sensitiveKeys.push(finalDbPasswordKey);

  const apiSecretKeys = sensitiveKeys.filter(k => backendInfo.usedEnvVars && backendInfo.usedEnvVars.includes(k));
  const frontendSecretKeys = sensitiveKeys.filter(k => frontendInfo.usedEnvVars && frontendInfo.usedEnvVars.includes(k));

  for (const s of additionalServices) {
    s.secretKeys = sensitiveKeys.filter(k => s.usedEnvVars && s.usedEnvVars.includes(k));
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
    if (!new RegExp('^' + passwordKey + '=', 'm').test(existingEnvContent)) {
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
      passwordKey
    };

    const isSpring = await detectSpringDatasourceConfig(s.path);
    if (isSpring) {
      // Spring Boot's relaxed env-var binding picks these up automatically -
      // no source code change needed, unlike every other framework Flarops
      // supports.
      const jdbcScheme = serviceDb.dbType === 'mysql' ? 'mysql' : (serviceDb.dbType === 'mariadb' ? 'mariadb' : 'postgresql');
      s.env['SPRING_DATASOURCE_URL'] = `jdbc:${jdbcScheme}://${s.name}-db:${serviceDb.port}/${s.db.name}`;
      s.env['SPRING_DATASOURCE_USERNAME'] = s.db.user;
      s.springDatasourcePasswordSecretKey = passwordKey;
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

      s.db = {
        type: dbInfo.dbType,
        image: dbInfo.image,
        port: dbInfo.port,
        user: dbInfo.dbUser || (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql' ? 'postgres' : 'root'),
        name: null, // each dbUrlVars entry below carries its own db name
        passwordKey: finalDbPasswordKey,
        shared: true
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
  // that same service - the secret reference always wins.
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

    additionalServices,
    apiSecretKeys,
    frontendSecretKeys,

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
    healthRoute: ${s.healthRoute ? '"' + s.healthRoute + '"' : 'null'}
    exposedRoutes: ${s.exposedRoutes && s.exposedRoutes.length > 0 ? '[' + s.exposedRoutes.map(r => '"' + r + '"').join(', ') + ']' : '[]'}
${s.command ? `    command:\n${s.command.map(a => '      - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}${(s.db && !s.db.shared) ? `    db:
      type: "${s.db.type}"
      image: "${s.db.image}"
      port: ${s.db.port}
      user: "${s.db.user}"
      name: "${s.db.name}"
` : ''}`;
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
  user: "${finalDbUser}"
  password: null
  name: "${finalDbName}"
  env:
    # KEY: "VALUE"
${config.hasBackend ? `api:
  healthRoute: ${config.apiHealthRoute ? '"' + config.apiHealthRoute + '"' : 'null'}
  secretKeys:
${config.apiSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${apiEnvString}
${config.apiCommand ? `  command:\n${config.apiCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}apiPorts:
${config.apiPorts.map(p => '  - ' + p).join('\n')}` : ''}
${config.hasFrontend ? `frontend:
  secretKeys:
${config.frontendSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${frontendEnvString}
${config.frontendCommand ? `  command:\n${config.frontendCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}frontendPorts:
${config.frontendPorts.map(p => '  - ' + p).join('\n')}` : ''}
${additionalServicesYaml}
apiRoutes:
${config.apiRoutes.map(p => '  - "' + p + '"').join('\n')}
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

  const templatesToGenerate = [
    { file: path.join(helmTemplatesDir, '01-ingress.yaml'), content: ingressTemplate(config) },
    { file: path.join(helmTemplatesDir, 'secret.yaml'), content: secretTemplate() },
    { file: path.join(helmTemplatesDir, 'dashboard.yaml'), content: dashboardYamlTemplate(config) }
  ];

  if (config.hasBackend) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'api.yaml'), content: apiServiceTemplate() + '\n---\n' + apiDeploymentTemplate(config) });
  }
  if (config.hasFrontend) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'frontend.yaml'), content: frontendServiceTemplate() + '\n---\n' + frontendDeploymentTemplate() });
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
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'database.yaml'), content: dbServiceTemplate() + '\n---\n' + dbDeploymentTemplate(config) });
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
    fs.cpSync(dashboardSourceDir, dashboardDestDir, { recursive: true });
  } else {
    console.warn("Dashboard source directory not found: " + dashboardSourceDir);
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

  if (hasLocalhostWarnings) {
    console.log(`\x1b[36mATTENTION: We found "localhost" references in your environment variables.\x1b[0m`);
    console.log(`\x1b[36mPlease open deploy/helm/values.yaml and change "localhost" to the appropriate service name (e.g. "api", "frontend", or "database") so containers can communicate properly in Kubernetes!\x1b[0m`);
    console.log("");
  }
};
