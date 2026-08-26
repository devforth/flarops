const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { getDefaultAWSCredentials, ensureAwsCli, handleS3Bucket } = require('../../utils/awsHelper.js');

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

const sensitiveRegex = /(PASSWORD|KEY|SECRET|TOKEN|CREDENTIALS|AUTH|SALT|CERT)/i;
const dbPasswordRegex = /^(DB_PASS|DB_PASSWORD|DATABASE_PASSWORD|DATABASE_PASS|DB_SECRET|DB_ROOT_PASSWORD|POSTGRES_PASSWORD|POSTGRESQL_PASSWORD|POSTGRES_PASS|PG_PASSWORD|PGPASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD|MYSQL_PASS|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|MONGO_PASSWORD|MONGO_PASS|MONGODB_PASSWORD|MONGO_ROOT_PASSWORD)$/i;

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

function processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext) {
  if (foundDbUrls[key]) return;
  if (dbPasswordRegex.test(key)) return;

  if (sensitiveRegex.test(key)) {
    const fullLine = `${key}=${val}`;
    if (!sensitiveContext.content.includes(fullLine)) {
      sensitiveContext.content += `${fullLine}\n`;
    }
  } else {
    if (isBackend) apiEnv[key] = val;
    if (isFrontend) frontendEnv[key] = val;
  }
}

function generateEnvString(envObj, context) {
  if (Object.keys(envObj).length === 0) return '    # KEY: "VALUE"';
  return Object.entries(envObj).map(([k, v]) => {
    let line = `    ${k}: "${v}"`;
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
    execSync(`ssh-keygen -t rsa -b 4096 -f "${privateKeyPath}" -q -N ""`);
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
      execSync(`echo "${registryPassword}" | docker login ${loginRegistry} -u "${registryUser}" --password-stdin`, { stdio: ['pipe', 'inherit', 'inherit'] });
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
    '.terraform.lock.hcl'
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
    }${cloudflareProviderBlock}
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

resource "aws_security_group" "sg" {
  name        = "\${var.instance_name}-sg"
  description = "Allow SSH, HTTP, and Kubernetes API"
  vpc_id      = aws_vpc.main.id

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

    curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --tls-san $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)" sh -
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
  description = "Name of the instance"
  type        = string
  default     = "${path.basename(currentDir)}-instance"
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
  default     = "${publicKey}"
  sensitive   = true
}
${cloudflareVarsBlock}
variable "domain" {
  description = "Domain Name"
  type        = string
  default     = "${domain}"
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

  const { analyzeBackend, analyzeFrontend } = require('../../utils/analyzer');
  const { analyzeDatabase, analyzeBackendForDbPasswordKey, analyzeBackendForDbKeys } = require('../../utils/dbAnalyzer');
  const { analyzeFrontendRoutes } = require('../../utils/routeAnalyzer');
  const { refactorFrontendEnv, refactorBackendDbUrl, refactorNginxConf, refactorLowercaseEnvVars } = require('../../utils/envRefactor');

  const [backendInfo, frontendInfo] = await Promise.all([
    analyzeBackend(currentDir),
    analyzeFrontend(currentDir)
  ]);

  const dbInfo = await analyzeDatabase(currentDir, backendInfo.backendPath);

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

  const envFiles = findEnvFiles(currentDir);
  let foundDbPasswords = [];

  let apiEnv = {};
  let frontendEnv = {};
  const sensitiveRegex = /(PASSWORD|KEY|SECRET|TOKEN|CREDENTIALS|AUTH|SALT|CERT)/i;
  let sensitiveEnvContent = '';

  for (const file of envFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const isRoot = file === path.join(currentDir, '.env');

    let isBackend = false;
    let isFrontend = false;

    if (backendInfo.backendPath && file.startsWith(backendInfo.backendPath)) {
      isBackend = true;
    } else if (frontendInfo.frontendPath && file.startsWith(frontendInfo.frontendPath)) {
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
        let val = lineMatch[2];
        val = sanitizeEnvValue(val);

        let sensitiveContext = { content: sensitiveEnvContent };
        processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext);
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

      let isBackend = ['api', 'backend', 'server'].includes(services[i].name) || (backendInfo.backendPath && backendInfo.backendPath.includes(services[i].name));
      let isFrontend = ['frontend', 'client', 'ui', 'web'].includes(services[i].name) || (frontendInfo.frontendPath && frontendInfo.frontendPath.includes(services[i].name));

      if (!isBackend && !isFrontend) continue;

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
            let val = sanitizeEnvValue(envLineMatch[2]);

            let sensitiveContext = { content: sensitiveEnvContent };
            processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext);
            sensitiveEnvContent = sensitiveContext.content;
          }
        }
      }
    }
  }

  if (dbInfo.hasDb) {
    let defaultDbPort = 3306;
    if (dbInfo.dbType === 'postgres' || dbInfo.dbType === 'postgresql') defaultDbPort = 5432;
    else if (dbInfo.dbType === 'mongodb') defaultDbPort = 27017;
    else if (dbInfo.dbType === 'redis') defaultDbPort = 6379;

    const dbHostKeys = Object.keys(apiEnv).filter(k => /(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i.test(k));
    
    let dbPrefix = 'DATABASE';
    if (dbHostKeys.length > 0) {
      dbPrefix = dbHostKeys[0].replace(/(_HOST|_HOSTNAME|_SERVER|_SERVER_NAME)$/i, '');
      dbHostKeys.forEach(k => {
        const val = String(apiEnv[k]).toLowerCase();
        if (/(db|database|mysql|postgres|mariadb|mongo|redis|localhost|127\.0\.0\.1)/i.test(val)) {
          apiEnv[k] = 'database';
        }
      });
    }

    const portKey = `${dbPrefix}_PORT`;
    if (!apiEnv[portKey] || isNaN(apiEnv[portKey])) {
      apiEnv[portKey] = String(defaultDbPort);
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
      let didUppercase = false;
      if (options.yes) {
         didUppercase = true;
      } else {
         const { confirmRefactor } = await require('inquirer').prompt([
           {
             type: 'confirm',
             name: 'confirmRefactor',
             message: `Found lowercase environment variables in backend code (${keysToUppercase.join(', ')}). Standard convention is UPPERCASE. Do you want to automatically refactor them?`,
             default: true
           }
         ]);
         didUppercase = confirmRefactor;
      }

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
    apiRoutes = await analyzeFrontendRoutes(frontendInfo.frontendPath);
    console.log(`Discovered API Routes in frontend: ${apiRoutes.join(', ')}`);
  }
  

  const relativeBackendPath = backendInfo.backendPath ? path.relative(currentDir, backendInfo.backendPath) || '.' : null;
  const relativeFrontendPath = frontendInfo.frontendPath ? path.relative(currentDir, frontendInfo.frontendPath) || '.' : null;

  const allEnvKeys = [];
  const envMatches = envContent.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm);
  for (const match of envMatches) {
    allEnvKeys.push(match[1]);
  }

  const excludedKeys = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SSH_PRIVATE_KEY', 'REGISTRY_USER', 'REGISTRY_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID']);
  const envKeysToPass = allEnvKeys.filter(k => !excludedKeys.has(k));

  const config = {
    projectName,
    domain,
    dockerRegistry,
    registryUser,
    envKeysToPass,
    backendPath: relativeBackendPath,
    frontendPath: relativeFrontendPath,
    apiDockerfile: backendInfo.dockerfile || 'Dockerfile',
    frontendDockerfile: frontendInfo.dockerfile || 'Dockerfile',
    images: {
      api: 'api:latest',
      db: dbInfo.hasDb && dbInfo.hasLocalDockerfile ? 'db:latest' : (dbInfo.hasDb && dbInfo.image ? dbInfo.image : 'postgres:15-alpine'),
      frontend: 'frontend:latest'
    },
    dbCloneSource: '', // Can be updated or prompted in the future
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
    
    for (const key of Object.keys(apiEnv)) {
      if (dbUserKeys.includes(key)) apiEnv[key] = finalDbUser;
      if (dbNameKeys.includes(key)) apiEnv[key] = finalDbName;
    }
  }

  let hasLocalhostWarnings = false;
  let contextObj = { hasLocalhostWarnings };

  let apiEnvString = generateEnvString(apiEnv, contextObj);
  let frontendEnvString = generateEnvString(frontendEnv, contextObj);

  hasLocalhostWarnings = contextObj.hasLocalhostWarnings;

  // Write values.yaml
  let valuesYaml = `projectName: ${projectName}
domain: "${domain}"
images:
  api: ${config.images.api}
  db: ${config.images.db}
  frontend: ${config.images.frontend}
dbCloneSource: "${config.dbCloneSource}"
dbType: ${config.dbType ? `"${config.dbType}"` : 'null'}
dbPort: ${config.dbPort || 'null'}
database:
  user: "${finalDbUser}"
  password: null
  name: "${finalDbName}"
  env:
    # KEY: "VALUE"
api:
  healthRoute: ${config.apiHealthRoute ? `"${config.apiHealthRoute}"` : 'null'}
  env:
${apiEnvString}
frontend:
  env:
${frontendEnvString}
apiPorts:
${config.apiPorts.map(p => `  - ${p}`).join('\n')}
frontendPorts:
${config.frontendPorts.map(p => `  - ${p}`).join('\n')}
apiRoutes:
${config.apiRoutes.map(p => `  - "${p}"`).join('\n')}
`;
  fs.writeFileSync(path.join(helmDir, 'values.yaml'), valuesYaml);

  const ingressTemplate = require('../../templates/01-ingress.js');
  const secretTemplate = require('../../templates/secret.js');
  const dbDeploymentTemplate = require('../../templates/database/deployment.js');
  const dbServiceTemplate = require('../../templates/database/service.js');
  const apiDeploymentTemplate = require('../../templates/api/deployment.js');
  const apiServiceTemplate = require('../../templates/api/service.js');
  const frontendDeploymentTemplate = require('../../templates/frontend/deployment.js');
  const frontendServiceTemplate = require('../../templates/frontend/service.js');

  const templatesToGenerate = [
    { file: path.join(helmTemplatesDir, '01-ingress.yaml'), content: ingressTemplate(config) },
    { file: path.join(helmTemplatesDir, 'secret.yaml'), content: secretTemplate() },
    { file: path.join(helmTemplatesDir, 'api.yaml'), content: apiServiceTemplate() + '\n---\n' + apiDeploymentTemplate(config) },
    { file: path.join(helmTemplatesDir, 'frontend.yaml'), content: frontendServiceTemplate() + '\n---\n' + frontendDeploymentTemplate() }
  ];

  if (config.dbType) {
    templatesToGenerate.push({ file: path.join(helmTemplatesDir, 'database.yaml'), content: dbServiceTemplate() + '\n---\n' + dbDeploymentTemplate(config) });
  }

  templatesToGenerate.forEach(t => fs.writeFileSync(t.file, t.content));

  // Generate GitHub Actions pipeline
  const githubDir = path.join(currentDir, '.github', 'workflows');
  ensureDir(githubDir, "Created .github/workflows/ directory");

  const otherFilesToGenerate = [
    { file: path.join(githubDir, 'deploy.yml'), content: require('../../templates/deploy.yml.js')(config) },
    { file: path.join(currentDir, 'werf.yaml'), content: require('../../templates/werf.yaml.js')(config) },
    { file: path.join(currentDir, 'werf-giterminism.yaml'), content: require('../../templates/werf-giterminism.yaml.js')() },
    { file: path.join(currentDir, 'FLAROPS.md'), content: require('../../templates/FLAROPS.md.js')() }
  ];

  otherFilesToGenerate.forEach(f => fs.writeFileSync(f.file, f.content));

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
