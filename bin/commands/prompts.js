// Everything `flarops init` asks the operator, in one place (stubbed by test/harness.js).

const path = require('path');
const { splitRegistry } = require('../../utils/registry.js');
// Enter accepts. The one [y/N] prompt (reusing an existing state bucket) lives in utils/awsHelper.js.
// At least two labels, each 1-63 letters, digits or hyphens, not starting or ending with a hyphen.
function isDomain(value) {
  return value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function isYes(answer) {
  const a = String(answer == null ? '' : answer).trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

module.exports = async function collectOperatorAnswers({
  currentDir, askQuestion, askPassword, execFileSync,
  ensureAwsCli, handleS3Bucket, getDefaultAWSCredentials,
}) {
  // "harbor.example.com/team" splits into the registry host and the project inside it; both can be
  // changed later under repositorySettings in flarops.yaml.
  const registryAnswer = await askQuestion('Enter docker registry, optionally with a project (e.g. harbor.example.com/team; leave empty for Docker Hub): ');
  const { host: dockerRegistry, project: dockerProject } = splitRegistry(registryAnswer);

  let registryUser = '';
  let registryPassword = '';

  const loginRegistry = dockerRegistry || 'docker.io';

  while (true) {
    registryUser = (await askQuestion(`Enter username for ${loginRegistry}: `)).trim();
    if (!registryUser) {
      console.log('username is required');
      continue;
    }
    registryPassword = (await askPassword(`Enter password for ${loginRegistry}: `)).trim();

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

  // Required: the dashboard and every PR environment are addressed under it, and an empty one
  // produced Ingress hosts ("dashboard.", "pr-1.") the API server rejects with the whole release.
  let domain = '';
  while (true) {
    domain = (await askQuestion('Enter project domain (e.g. app.example.com): ')).trim().toLowerCase().replace(/\.$/, '');
    if (isDomain(domain)) break;
    console.log(domain ? `"${domain}" is not a domain name - expected something like app.example.com` : 'domain is required');
  }

  let cloudflareApiToken = '';
  let cloudflareZoneId = '';
  if (domain) {
    const useCloudflare = await askQuestion('Do you want to configure Cloudflare DNS for this domain automatically? [Y/n]: ');
    if (isYes(useCloudflare)) {
      cloudflareApiToken = (await askPassword('Enter Cloudflare API Token: ')).trim();
      cloudflareZoneId = (await askQuestion('Enter Cloudflare Zone ID: ')).trim();
    }
  }
  let projectName = path.basename(currentDir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!projectName) projectName = 'flarops-project';
  let awsCredentials = { accessKey: '', secretKey: '' };
  const accessKeyInput = await askQuestion('Enter project AWS Access Key ID (press Enter to use your default credentials): ');

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
    const secretKeyInput = await askPassword('Enter project AWS Secret Access Key: ');
    awsCredentials.secretKey = secretKeyInput.trim();
  }

  const regionAnswer = await askQuestion('Enter AWS region (press Enter for us-west-2): ');
  const awsRegion = regionAnswer.trim() || 'us-west-2';

  const awsCmd = ensureAwsCli();
  const defaultBucketName = `${projectName}-remote-state`;
  const bucketResult = await handleS3Bucket(awsCmd, defaultBucketName, awsCredentials, askQuestion, awsRegion);
  const remoteStateBucket = bucketResult.bucket;
  let s3BucketWarning = bucketResult.warning;

  return {
    projectName, dockerRegistry, dockerProject, dockerRepository: projectName, registryUser, registryPassword,
    domain, cloudflareApiToken, cloudflareZoneId,
    awsCredentials, awsRegion, remoteStateBucket, s3BucketWarning,
  };
};

module.exports.isYes = isYes;
module.exports.isDomain = isDomain;
