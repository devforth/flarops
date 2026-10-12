// Everything `flarops init` asks the operator, in one place (stubbed by test/harness.js).

const path = require('path');
const { splitRegistry, REGISTRY_HOST, IMAGE_PATH } = require('../../utils/registry.js');
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
  ensureAwsCli, handleS3Bucket, getDefaultAWSCredentials, checkAwsAccess,
}) {
  // Names "<project>-production" and "<project>-pr-<n>" must stay within Kubernetes' 63 characters.
  let projectName = path.basename(currentDir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 50).replace(/-+$/, '');
  if (!projectName) projectName = 'flarops-project';
  console.log(`Project name: ${projectName} (from this directory's name). It names the image repository, the`);
  console.log(`Kubernetes namespaces (${projectName}-production, ${projectName}-pr-<N>) and the Terraform state bucket.`);
  console.log('');

  // The tools come first, so a missing one stops init before any question rather than after all of them.
  const awsCmd = await ensureAwsCli(askQuestion);

  let dockerRegistry = '';
  let dockerProject = null;
  let registryUser = '';
  let registryPassword = '';
  let loginRegistry = 'docker.io';

  // docker only checks the registry login here (images are built in CI); without it, the check is skipped.
  let canCheckLogin = true;
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
  } catch (e) {
    canCheckLogin = false;
    console.log('\x1b[33mdocker is not installed or not on PATH, so the registry login cannot be checked here - continuing without the check.\x1b[0m');
  }

  // A failed login asks for the registry again too: a wrong host is as likely as a wrong password.
  while (true) {
    // "harbor.example.com/team" splits into the registry host and the project inside it; both can be
    // changed later under repositorySettings in flarops.yaml.
    const registryAnswer = (await askQuestion('Enter docker registry, optionally with a project (e.g. harbor.example.com/team; leave empty for Docker Hub): '))
      .trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    ({ host: dockerRegistry, project: dockerProject } = splitRegistry(registryAnswer));
    if ((dockerRegistry && !REGISTRY_HOST.test(dockerRegistry)) || (dockerProject && !IMAGE_PATH.test(dockerProject))) {
      console.log(`"${registryAnswer}" is not a registry - expected a host such as harbor.example.com, optionally followed by /project`);
      continue;
    }
    loginRegistry = dockerRegistry || 'docker.io';

    registryUser = '';
    while (!registryUser) {
      registryUser = (await askQuestion(`Enter username for ${loginRegistry}: `)).trim();
      if (!registryUser) console.log('username is required');
    }
    registryPassword = (await askPassword(`Enter password or access token for ${loginRegistry}: `)).trim();

    if (!canCheckLogin) break;
    console.log();
    console.log(`Logging in to ${loginRegistry} ...`);
    try {
      execFileSync('docker', ['login', loginRegistry, '-u', registryUser, '--password-stdin'], { input: registryPassword, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log('Logged in.');
      console.log();
      break;
    } catch (err) {
      const reason = String((err.stderr && err.stderr.toString()) || err.message || '').trim().split('\n').pop();
      console.error();
      console.error(`\x1b[31mdocker login to ${loginRegistry} failed: ${reason || 'no reason given'}\x1b[0m`);
      console.error('Check the registry, username and password. A Docker Hub account with two-factor authentication needs an access token instead of the password.');
      const next = (await askQuestion('[R]etry, [s]kip the check, or [q]uit? ')).trim().toLowerCase();
      if (next === 's' || next === 'skip') break;
      if (next === 'q' || next === 'quit') process.exit(1);
      console.log();
    }
  }

  // Required: the dashboard and every PR environment are addressed under it, and an empty one
  // produced Ingress hosts ("dashboard.", "pr-1.") the API server rejects with the whole release.
  let domain = '';
  console.log('');
  console.log('The domain the application is served at. The dashboard and the pull request environments get');
  console.log('addresses next to it: for app.example.com, dashboard.example.com and app-pr-<N>.example.com.');
  while (true) {
    domain = (await askQuestion('Enter project domain (e.g. app.example.com): ')).trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
    if (isDomain(domain)) break;
    console.log(domain ? `"${domain}" is not a domain name - expected something like app.example.com` : 'domain is required');
  }
  {
    const parts = domain.split('.');
    const parent = parts.length > 2 ? parts.slice(1).join('.') : domain;
    const prHost = parts.length > 2 ? `${parts[0]}-pr-<N>.${parent}` : `pr-<N>.${domain}`;
    console.log(`  application: https://${domain}   dashboard: https://dashboard.${parent}   PR environments: https://${prHost}`);
    console.log('');
  }

  let cloudflareApiToken = '';
  let cloudflareZoneId = '';
  if (domain) {
    console.log('With Cloudflare, the deploy creates the DNS records itself: the domain, the wildcard for the');
    console.log('PR environments and the dashboard. Without it, you create them after the first deploy (FLAROPS.md lists them).');
    const useCloudflare = await askQuestion('Do you want to configure Cloudflare DNS for this domain automatically? [Y/n] ');
    if (isYes(useCloudflare)) {
      console.log('  The token needs Zone > DNS > Edit for this zone (My Profile > API Tokens > Create Token, "Edit zone DNS").');
      cloudflareApiToken = (await askPassword('Enter Cloudflare API Token (empty to skip Cloudflare): ')).trim();
      if (cloudflareApiToken) {
        console.log('  The Zone ID is on the domain\'s Overview page in Cloudflare, in the API section on the right.');
        cloudflareZoneId = (await askQuestion('Enter Cloudflare Zone ID (empty to skip Cloudflare): ')).trim();
      }
      if (!cloudflareApiToken || !cloudflareZoneId) {
        cloudflareApiToken = '';
        cloudflareZoneId = '';
        console.log('Cloudflare skipped: create the DNS records yourself after the first deploy (FLAROPS.md lists them).');
      }
    }
  }

  // Credentials, then the region, checked against AWS at once: a wrong key or a misspelt region is
  // found here, not at the end.
  const found = getDefaultAWSCredentials();
  let awsCredentials;
  let awsRegion;
  console.log('');
  while (true) {
    awsCredentials = { accessKey: '', secretKey: '' };
    const accessKeyInput = (await askQuestion(found
      ? `Enter project AWS Access Key ID (press Enter to use ${found.source}): `
      : 'Enter project AWS Access Key ID: ')).trim();
    if (!accessKeyInput && found) {
      awsCredentials = { accessKey: found.accessKey, secretKey: found.secretKey };
      console.log(`Using the AWS credentials from ${found.source}.`);
    } else if (!accessKeyInput) {
      console.log('No AWS credentials found on this machine (environment, AWS_PROFILE or ~/.aws/credentials) - enter a key.');
      continue;
    } else {
      awsCredentials.accessKey = accessKeyInput;
      awsCredentials.secretKey = (await askPassword('Enter project AWS Secret Access Key: ')).trim();
    }
    awsRegion = (await askQuestion('Enter AWS region (press Enter for us-west-2): ')).trim() || 'us-west-2';
    const access = checkAwsAccess ? checkAwsAccess(awsCmd, awsCredentials, awsRegion) : { ok: true };
    if (access.ok) {
      if (access.account) console.log(`AWS account ${access.account}, region ${awsRegion}.`);
      break;
    }
    console.error(`\x1b[31m${access.message}\x1b[0m`);
    const next = (await askQuestion('[R]etry, or [q]uit? ')).trim().toLowerCase();
    if (next === 'q' || next === 'quit') process.exit(1);
  }

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
