// Everything `flarops init` asks the operator, in one place.
//
// Extracted from init.js for one concrete reason: while these prompts sat in
// the middle of the generation function, no part of init could run without a
// TTY, an AWS account and a Docker daemon - so nothing about the generator was
// testable, and every template change was verified by hand or not at all.
// With the questions behind one call, test/harness.js stubs this and the whole
// analysis and generation path runs for real.
//
// It returns a plain object and reads nothing from the caller's scope, so the
// answers cannot be quietly mutated later in the generation.

const path = require('path');
// Every choice prompt in init is "[Y/n]": pressing Enter accepts. The one
// exception lives in utils/awsHelper.js - reusing a bucket that already exists
// is not something to agree to by reflex, so it stays "[y/N]" and Enter
// declines.
//
// Written once because the four call sites each parsed the answer themselves,
// and a default that is only right in three of them is worse than none.
function isYes(answer) {
  const a = String(answer == null ? '' : answer).trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

module.exports = async function collectOperatorAnswers({
  currentDir, askQuestion, askPassword, execFileSync,
  ensureAwsCli, handleS3Bucket, getDefaultAWSCredentials,
}) {
  const registryAnswer = await askQuestion('Enter docker registry (leave empty for Docker Hub): ');
  const dockerRegistry = registryAnswer.trim();

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

  const domainAnswer = await askQuestion('Enter project domain (press Enter to skip if you are not using one): ');
  const domain = domainAnswer.trim();

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

  // One answer, one region. This value used to be hardcoded in three places
  // that disagreed: the CI workflows and the S3 state bucket said us-west-2
  // while Terraform's own aws_region variable defaulted to eu-central-1, so
  // the infrastructure ran in a different region from its own state and from
  // whatever the CI session was configured for. Everything downstream reads
  // this one value.
  const regionAnswer = await askQuestion('Enter AWS region (press Enter for us-west-2): ');
  const awsRegion = regionAnswer.trim() || 'us-west-2';

  const awsCmd = ensureAwsCli();
  const defaultBucketName = `${projectName}-remote-state`;
  const bucketResult = await handleS3Bucket(awsCmd, defaultBucketName, awsCredentials, askQuestion, awsRegion);
  const remoteStateBucket = bucketResult.bucket;
  let s3BucketWarning = bucketResult.warning;

  return {
    projectName, dockerRegistry, registryUser, registryPassword,
    domain, cloudflareApiToken, cloudflareZoneId,
    awsCredentials, awsRegion, remoteStateBucket, s3BucketWarning,
  };
};

module.exports.isYes = isYes;
