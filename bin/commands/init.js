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

  const mainTfContent = `terraform {
  backend "s3" {
    bucket = "${remoteStateBucket}"
    key    = "terraform.tfstate"
    region = "us-west-2"
  }
}

provider "aws" {
  region = var.aws_region
}

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

output "public_ip" {
  value = aws_eip.eip.public_ip
}
`;

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
`;

  const mainTfFile = path.join(terraformDir, 'main.tf');
  writeFileIfNotExists(mainTfFile, mainTfContent, "Created deploy/terraform/main.tf", "deploy/terraform/main.tf already exists and is not empty");

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
      } catch (e) {}
    }
    return fileList;
  }

  const { analyzeBackend, analyzeFrontend } = require('../../utils/analyzer.js');
  const { analyzeDatabase } = require('../../utils/dbAnalyzer.js');

  const [backendInfo, frontendInfo] = await Promise.all([
    analyzeBackend(currentDir),
    analyzeFrontend(currentDir)
  ]);

  const dbInfo = await analyzeDatabase(currentDir, backendInfo.backendPath);

  const envFiles = findEnvFiles(currentDir);
  let foundDbPasswords = [];
  let foundDbUrls = {};
  
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
        } catch (e) {}
        foundDbUrls[key] = { key, query };
      }
    }
    
    const lines = content.split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
      if (lineMatch) {
        const key = lineMatch[1];
        const val = lineMatch[2];
        
        const cleanedVal = val.replace(/^["']|["']$/g, '').trim();
        let sensitiveContext = { content: sensitiveEnvContent };
        processEnvVariable(key, cleanedVal, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext);
        sensitiveEnvContent = sensitiveContext.content;
      }
    }
  }

  // Parse docker-compose.yml environment blocks
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  let composeContent = null;
  for (const cf of composeFiles) {
    try {
      composeContent = fs.readFileSync(path.join(currentDir, cf), 'utf8');
      break;
    } catch(e) {}
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
            const val = envLineMatch[2].replace(/^["']|["']$/g, '').trim();
            
            let sensitiveContext = { content: sensitiveEnvContent };
            processEnvVariable(key, val, isBackend, isFrontend, foundDbUrls, apiEnv, frontendEnv, sensitiveContext);
            sensitiveEnvContent = sensitiveContext.content;
          }
        }
      }
    }
  }

  let finalDbPasswordKey = 'DATABASE_PASSWORD';
  let finalDbPassword = '';
  if (foundDbPasswords.length > 0) {
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
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
`;

  envContent += `\n# Extracted sensitive variables from project .env files\n${sensitiveEnvContent}`;

  if (finalDbPassword && !envContent.includes(`${finalDbPasswordKey}=`)) {
    envContent += `${finalDbPasswordKey}="${finalDbPassword}"\n`;
  }

  const envFile = path.join(deployDir, '.env');
  if (!fs.existsSync(envFile)) {
    fs.writeFileSync(envFile, envContent);
    console.log("Created deploy/.env");
  } else {
    console.log("deploy/.env already exists");
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
    dbUrlVars: Object.values(foundDbUrls)
  };

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
  env:
${apiEnvString}
frontend:
  env:
${frontendEnvString}
apiPorts:
${config.apiPorts.map(p => `  - ${p}`).join('\n')}
frontendPorts:
${config.frontendPorts.map(p => `  - ${p}`).join('\n')}
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
    { file: path.join(helmTemplatesDir, '01-ingress.yaml'), content: ingressTemplate() },
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
