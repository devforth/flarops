// Checks for the state-bucket dialogue against a fake `aws` CLI: a bucket owned by another account
// answers HeadBucket with the same bare 403 as a wrong key.

const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeAws(dir, { credentialsValid }) {
  const file = path.join(dir, 'aws');
  fs.writeFileSync(file, `#!/bin/sh
case "$1 $2" in
  "sts get-caller-identity")
    ${credentialsValid
      ? 'echo \'{"Account":"111111111111"}\'; exit 0'
      : 'echo "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid." >&2; exit 254'} ;;
  "s3api head-bucket")
    case "$*" in
      *" taken"*) echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254 ;;
      *) echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
    esac ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  return file;
}

async function withExitTrapped(fn) {
  const realExit = process.exit;
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  const said = [];
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  console.error = console.warn = console.log = (...args) => said.push(args.join(' '));
  let result = null;
  try {
    result = await fn();
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.exit = realExit;
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
  }
  return { result, exitCode, said: said.join('\n') };
}

async function run(check) {
  const { handleS3Bucket } = require('../utils/awsHelper.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flarops-aws-test-'));
  try {
    const creds = { accessKey: 'AKIATEST', secretKey: 'secret' };

    const asked = [];
    const taken = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: true }), 'taken', creds,
      async (q) => { asked.push(q); return 'mine'; }, 'us-west-2'));
    check('a bucket name owned by another account does not end init', taken.exitCode === null, taken.said);
    check('it asks for a different name instead', asked.some(q => /new bucket name/i.test(q)), asked.join(' | '));
    check('and says the name is taken, not that the credentials are wrong',
      /already taken by another AWS account/.test(taken.said) && !/UNAUTHORIZED/.test(taken.said), taken.said);
    check('the new name is the one used', taken.result && taken.result.bucket === 'mine', JSON.stringify(taken.result));

    const bad = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: false }), 'anything', creds, async () => 'x', 'us-west-2'));
    check('wrong credentials still stop init', bad.exitCode === 1, bad.said);
    check('and say so', /UNAUTHORIZED/.test(bad.said) && /InvalidClientTokenId/.test(bad.said), bad.said);

    const { getDefaultAWSCredentials, checkAwsAccess } = require('../utils/awsHelper.js');
    const fromEnv = getDefaultAWSCredentials({ AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'envsecret' });
    check('credentials in the environment are used', fromEnv && fromEnv.accessKey === 'AKIAENV' && /environment/.test(fromEnv.source), JSON.stringify(fromEnv));
    const temporary = getDefaultAWSCredentials({ AWS_ACCESS_KEY_ID: 'ASIATMP', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', HOME: dir });
    check('expiring session credentials are not offered', !temporary || temporary.accessKey !== 'ASIATMP', JSON.stringify(temporary));

    const typo = checkAwsAccess(fakeAws(dir, { credentialsValid: true }), creds, 'us-wset-2x');
    check('a misspelt region is caught before AWS is asked', !typo.ok && typo.region, JSON.stringify(typo));
    const good = checkAwsAccess(fakeAws(dir, { credentialsValid: true }), creds, 'eu-central-1');
    check('valid credentials pass the early check, with their account', good.ok && good.account === '111111111111', JSON.stringify(good));
    const wrong = checkAwsAccess(fakeAws(dir, { credentialsValid: false }), creds, 'eu-central-1');
    check('wrong credentials fail the early check, saying why', !wrong.ok && /rejected these credentials/.test(wrong.message), JSON.stringify(wrong));

    fs.mkdirSync(path.join(dir, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.aws', 'credentials'), '[default]\naws_access_key_id = ASIAPROFILE\naws_secret_access_key = s\naws_session_token = t\n[static]\naws_access_key_id = AKIASTATIC\naws_secret_access_key = s\n');
    const sessionProfile = getDefaultAWSCredentials({ HOME: dir });
    check('a profile holding a session token is treated as absent', sessionProfile === null, JSON.stringify(sessionProfile));
    const staticProfile = getDefaultAWSCredentials({ HOME: dir, AWS_PROFILE: 'static' });
    check('a profile with long-lived keys is offered', staticProfile && staticProfile.accessKey === 'AKIASTATIC', JSON.stringify(staticProfile));

    const { awsEnv } = require('../utils/awsHelper.js');
    const proxied = awsEnv(creds, { PATH: '/bin', HOME: dir, HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', AWS_CA_BUNDLE: '/etc/ca.pem', SECRET_OTHER: 'x' });
    check('the AWS CLI gets the proxy and CA bundle settings, in either case, and nothing else',
      proxied.HTTPS_PROXY === 'http://proxy:3128' && proxied.no_proxy === 'localhost' && proxied.AWS_CA_BUNDLE === '/etc/ca.pem' && !('SECRET_OTHER' in proxied) && proxied.AWS_ACCESS_KEY_ID === 'AKIATEST',
      JSON.stringify(proxied));

    const decided = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: true }), 'fresh', creds, async () => 'y', 'us-west-2'));
    check('a free bucket name is only decided on, to be created after the questions',
      decided.result && decided.result.bucket === 'fresh' && decided.result.create === true && !/Creating S3 bucket/.test(decided.said), JSON.stringify(decided.result) + decided.said);
    const { createStateBucket } = require('../utils/awsHelper.js');
    const created = await withExitTrapped(() => createStateBucket(
      fakeAws(dir, { credentialsValid: true }), 'fresh', creds, async () => 'other', 'us-west-2'));
    check('and createStateBucket creates it', created.result === 'fresh' && /Creating S3 bucket: fresh/.test(created.said), JSON.stringify(created.result) + created.said);

    const names = ['', 'second'];
    const emptyName = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: true }), 'taken', creds, async () => names.shift(), 'us-west-2'));
    check('an empty bucket name is asked again, not turned into "000"', emptyName.result && emptyName.result.bucket === 'second', JSON.stringify(emptyName.result) + emptyName.said);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
