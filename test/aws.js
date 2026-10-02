// Checks for the state-bucket dialogue in utils/awsHelper.js, against a fake
// `aws` that answers the way the real CLI does.
//
// The case that matters: HeadBucket on a name owned by ANOTHER account returns
// a bare "(403) Forbidden" - the same answer a wrong key gets. Treated as bad
// credentials, it ended init on a plain name collision, before it ever asked
// for a different name.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Answers by subcommand. `taken` is a bucket that exists in someone else's
// account; every other name does not exist yet.
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

    // A name owned by another account: ask for another one, do not abort.
    const asked = [];
    const taken = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: true }), 'taken', creds,
      async (q) => { asked.push(q); return 'mine'; }, 'us-west-2'));
    check('a bucket name owned by another account does not end init', taken.exitCode === null, taken.said);
    check('it asks for a different name instead', asked.some(q => /new bucket name/i.test(q)), asked.join(' | '));
    check('and says the name is taken, not that the credentials are wrong',
      /already taken by another AWS account/.test(taken.said) && !/UNAUTHORIZED/.test(taken.said), taken.said);
    check('the new name is the one used', taken.result && taken.result.bucket === 'mine', JSON.stringify(taken.result));

    // Genuinely wrong credentials still stop, with the reason.
    const bad = await withExitTrapped(() => handleS3Bucket(
      fakeAws(dir, { credentialsValid: false }), 'anything', creds, async () => 'x', 'us-west-2'));
    check('wrong credentials still stop init', bad.exitCode === 1, bad.said);
    check('and say so', /UNAUTHORIZED/.test(bad.said) && /InvalidClientTokenId/.test(bad.said), bad.said);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
