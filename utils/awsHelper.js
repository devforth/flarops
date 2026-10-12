const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// Credentials already on this machine, as the AWS CLI finds them: AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY in the environment, else the AWS_PROFILE (or default) profile in
// ~/.aws/credentials. Session credentials are skipped: they expire, and these go into GitHub Secrets.
function getDefaultAWSCredentials(env = process.env) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && !env.AWS_SESSION_TOKEN) {
    return { accessKey: env.AWS_ACCESS_KEY_ID, secretKey: env.AWS_SECRET_ACCESS_KEY, source: 'AWS_ACCESS_KEY_ID in the environment' };
  }
  const profile = env.AWS_PROFILE || 'default';
  try {
    const credPath = path.join(os.homedir(), '.aws', 'credentials');
    if (!fs.existsSync(credPath)) return null;
    let inProfile = false;
    let accessKey = '';
    let secretKey = '';
    for (const line of fs.readFileSync(credPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inProfile = trimmed === `[${profile}]`;
        continue;
      }
      if (!inProfile) continue;
      const [k, ...v] = trimmed.split('=');
      if (k.trim() === 'aws_access_key_id') accessKey = v.join('=').trim();
      else if (k.trim() === 'aws_secret_access_key') secretKey = v.join('=').trim();
    }
    if (accessKey && secretKey) return { accessKey, secretKey, source: `the "${profile}" profile in ~/.aws/credentials` };
  } catch (err) { /* unreadable: as if absent */ }
  return null;
}

const REGION = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/;

// Asks AWS who these credentials belong to, in this region: a wrong key and a region that does not
// exist are both found here, before any question that depends on them.
function checkAwsAccess(awsCmd, credentials, region) {
  if (!REGION.test(region)) return { ok: false, region: true, message: `"${region}" is not an AWS region - expected something like us-west-2 or eu-central-1` };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AWS_ACCESS_KEY_ID: credentials.accessKey, AWS_SECRET_ACCESS_KEY: credentials.secretKey };
  try {
    const out = execFileSync(awsCmd, ['sts', 'get-caller-identity', '--region', region, '--output', 'json'], { env, stdio: 'pipe' }).toString();
    let account = '';
    try { account = JSON.parse(out).Account || ''; } catch (e) { /* not JSON: still a success */ }
    return { ok: true, account };
  } catch (error) {
    const stderr = (error.stderr ? error.stderr.toString() : String(error.message || '')).trim();
    if (/Could not connect to the endpoint|InvalidRegion|UnrecognizedClientException.*region|Name or service not known/i.test(stderr)) {
      return { ok: false, region: true, message: `AWS does not answer in region "${region}" - check its spelling` };
    }
    if (/InvalidClientTokenId|SignatureDoesNotMatch|AuthFailure|ExpiredToken|InvalidAccessKeyId/.test(stderr)) {
      return { ok: false, message: `AWS rejected these credentials: ${stderr.split('\n').pop()}` };
    }
    return { ok: false, message: `could not check the credentials: ${stderr.split('\n').pop() || 'no reason given'}` };
  }
}

// Embedded, not fetched; the fingerprint below is what decides trust.
const AWS_CLI_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
aGveYQUJDMpiLAAKCRCmMQrMRnJHXKBYD/9Ab0qQdGiO5hObchG8xh8Rpb4Mjyf6
0JrVo6m8GNjNj6BHkSc8fuTQJ/FaEhaQxj3pjZ3GXPrXjIIVChmICLlFuRXYzrXc
Pw0lniybypsZEVai5kO0tCNBCCFuMN9RsmmRG8mf7lC4FSTbUDmxG/QlYK+0IV/l
uJkzxWa+rySkdpm0JdqumjegNRgObdXHAQDWlubWQHWyZyIQ2B4U7AxqSpcdJp6I
S4Zds4wVLd1WE5pquYQ8vS2cNlDm4QNg8wTj58e3lKN47hXHMIb6CHxRnb947oJa
pg189LLPR5koh+EorNkA1wu5mAJtJvy5YMsppy2y/kIjp3lyY6AmPT1posgGk70Z
CmToEZ5rbd7ARExtlh76A0cabMDFlEHDIK8RNUOSRr7L64+KxOUegKBfQHb9dADY
qqiKqpCbKgvtWlds909Ms74JBgr2KwZCSY1HaOxnIr4CY43QRqAq5YHOay/mU+6w
hhmdF18vpyK0vfkvvGresWtSXbag7Hkt3XjaEw76BzxQH21EBDqU8WJVjHgU6ru+
DJTs+SxgJbaT3hb/vyjlw0lK+hFfhWKRwgOXH8vqducF95NRSUxtS4fpqxWVaw3Q
V2OWSjbne99A5EPEySzryFTKbMGwaTlAwMCwYevt4YT6eb7NmFhTx0Fis4TalUs+
j+c7Kg92pDx2uYkCVAQTAQgAPgIbAwULCQgHAgYVCgkICwIEFgIDAQIeAQIXgBYh
BPtdt3/VwRi4BRGtqKYxCsxGckdcBQJmoVhvBQkK/9w6AAoJEKYxCsxGckdcpi4Q
AL7C1nrXWpC06XS3mykz1JZm6zNtzIDTEEAmramdyenrB0I6S4A+7j9HdQIigPYL
j0yQuP1jRi+57wIIXo4gnwv58oG/YMjJZkaYcvSn3Br9fw0IpCsrErWCrk+4LOLd
/dKrB9tm5kZ4r+5uea221ZelS25T8jNVHS7/SwDLePi5MYqHZxftedltKqAmFST0
ffbiYgmJLDO/DUp6vrG0f8vB0F4kJyRtUF2HctmKzjO4Pghl4E7W9G+Oi3c6rjFp
1S/lFI8BODtPWSK+u0sKfC+pzovgucXQ6Q3KyT3gvctBIfJBbaRBLVxXCv7IZRKJ
Kn5W8xsChsBqmYwlY/p790rIBQYhfr7bBot1sGzZTsxfOfH/ZrIIs8fuoJj1x6dt
2PkmEb2JtW8VaqqFKjbYH9RFAT8Iysb7fFfC0cQGgzJYQBOvW1bCfbLJAZuRQYA2
d5IMWJMV6hC8o3LIIVMU7UXZcoJy4OzX2ePfg8TZMmKVMbZBGUyvgPQ2DAssAyDY
uizUIrqddaciZgcq5opL0tVoKgLy+7shEGKTU1fpKOtCd+2TQz11j6zRlsA3WBt2
NnwfeqVuX/hPEx2vzubws/gVkgijbrUTJy/filWQJ49mI/52BqYSJAnsgvhkCuKj
2a/odsMZXqYtjjn6Xr/QTMLCQjkjIh8F9YL2z9RKDFyGiQJUBBMBCAA+AhsDBQsJ
CAcCBhUKCQgLAgQWAgMBAh4BAheAFiEE+123f9XBGLgFEa2opjEKzEZyR1wFAmTC
nBIFCQkhH90ACgkQpjEKzEZyR1wopQ/+L4qK/SebQfonK4uVmw7nUt2pP73uKl0u
mS5uUvJfggccuWi0FJchYbmmhBwwtdXxu/DnbsWrc3hxDQEmFaN5pijcKwgc2jSW
nmliixkE9DCsAUj+Wmt3b2vD/+KFD/RrEJ9LlqF8DQ1n6zGzSPIJ/owv9zIoFrw9
37uswjlliyEzb9kiaEJcCC5m/7hn4WuvKOIkwTr3H7VUbmqOg8qhfgqx1/9I9JJR
A0BTGPTOLbGE+1/DVnyPFZnPPZ86by/X8HWuOFsKSiMNRQWT/EtLIA8dsQ7Mby/J
DNhrToh9HB6hTvle8bUymcpaJYg2ySobvNCnPmAv05qMw/KHhlNqxBV3y3oMEs0/
Tfowd/Pnamj/aUQ7IuOYhqsgPMmr1QWm6S9CEPY1OniFfpJnIyI3Lp/1KPEoydMU
ALJuNa8T2ileryVJ9dMFTboUpCpPJszTpUmcLux7muq3XAmhngfLieOAD90M1gTZ
647aDegJTdA9sBZnxP2C/6xz8VNV8D57bm2Af7d61xS+xDUDjkB9ClV4EQpXsrBz
IJYOOnPp0C0c1U7IYw45rc74fa3FfUSkaD3rRIIMwqA/Pb3gwPYz0disOkWJEl82
JtnxL9evx0TWLe4Sc53hakSIx1uagIErP23GkVqQFP0EM8yT1SgkDa+MtMHsoAfB
wrRo36HdKdSJAlQEEwEIAD4WIQT7Xbd/1cEYuAURraimMQrMRnJHXAUCXYKvtQIb
AwUJB4TOAAULCQgHAgYVCgkICwIEFgIDAQIeAQIXgAAKCRCmMQrMRnJHXJIXEACh
LUIkg80uPUkGjE3jejvQSA1aWuAMyzy6fdpdlRUz6M6nmsUhOExjVIvibEJpzK5m
huSZ4lb0vJ2ZUPgCv4zs2nBd7BGJMxKiWgBReGvTdqZ0SzyYH4PYCJSE732x/Fw9
hfnh1dMTXNcrQXzwOmmFNNegG0Oxau+VnpcR5Kz3smiTrIwZbRudo1ijhCYPQ7t5
CMp9kjC6bObvy1hSIg2xNbMAN/DoikebAl36uA6Y/Uczjj3GxZW4ZWeFirMidKbt
qvUz2y0UFszobjiBSqZZHCreC34Bhw9bFNpuWC/0SrXgohdsc6vK50pDGdV5kM2q
o9tMQ/izsAwTh/d/GzZv8H4lV9eOtEis+EpR497PaxKKh9tJf0N6Q1YLRHof5xeP
ZtOIlS3gfvsH5hXA3HJ9yIxb8T0HQYmVr3aIUes20i6meI3fuV36VFupwfrTKaL7
VXnsrK2fq5cRvyJLNzXucg0WAjPFRrAGLzY7nP1xeg1a0aeP+pdsqjqlPJom8OCW
c1+6DWbg0jsC74WoesAqgBItODMBrsal1y/q+bPzpsnWjzHV8+1/EtZmSc8ZUGSJ
OPkfC7hObnfkl18h+1QtKTjZme4dH17gsBJr+opwJw/Zio2LMjQBOqlm3K1A4zFT
h7wBC7He6KPQea1p2XAMgtvATtNeYLZATHZKTJyiqA==
=GIEm
-----END PGP PUBLIC KEY BLOCK-----
`;

// From the AWS CLI User Guide. A list, so a key rotation can add a fingerprint beside the old one.
const AWS_CLI_KEY_FINGERPRINTS = ['FB5DB77FD5C118B80511ADA8A6310ACC4672475C'];

function rotationMessage(seen) {
  return `the archive is signed by a key this version of Flarops does not know: ${seen}\n` +
    `  expected one of: ${AWS_CLI_KEY_FINGERPRINTS.join(', ')}\n` +
    '  If AWS has rotated its signing key, check the new fingerprint against\n' +
    '  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n' +
    '  and add it to AWS_CLI_KEY_FINGERPRINTS in utils/awsHelper.js.';
}

function resolveTrustedAwsPath(candidatePath) {
  if (!candidatePath) return null;
  try {
    const real = fs.realpathSync(candidatePath);
    const cwdReal = fs.realpathSync(process.cwd());
    // Never trust a binary inside the project being scanned.
    if (real === cwdReal || real.startsWith(cwdReal + path.sep)) {
      return null;
    }
    return real;
  } catch (e) {
    return null;
  }
}

function looksLikeAwsCli(awsPath) {
  try {
    const out = execFileSync(awsPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return /aws-cli\//.test(out);
  } catch (e) {
    const combined = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    return /aws-cli\//.test(combined);
  }
}

// The CLI downloads AWS publishes for Linux, by Node's architecture name.
const LINUX_BUILDS = { x64: 'x86_64', arm64: 'aarch64' };

// askQuestion: ask before installing anything (absent, it installs without asking).
async function ensureAwsCli(askQuestion) {
  // Resolve `aws` once to an absolute path; a bare 'aws' would be re-resolved through PATH each call.
  try {
    const resolvedFromPath = execSync('command -v aws', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const trusted = resolveTrustedAwsPath(resolvedFromPath);
    if (trusted && looksLikeAwsCli(trusted)) return trusted;
    if (trusted) {
      console.warn(`\x1b[33mWARNING: Found "aws" on your PATH at ${trusted}, but it doesn't behave like the real AWS CLI ("aws --version" didn't report aws-cli). Ignoring it and installing a trusted copy instead.\x1b[0m`);
    }
  } catch (e) { /* not found on PATH */ }

  {
    const localAwsPath = path.join(os.homedir(), '.local', 'bin', 'aws');
    if (fs.existsSync(localAwsPath) && looksLikeAwsCli(localAwsPath)) {
      return fs.realpathSync(localAwsPath);
    }

    const build = process.platform === 'linux' ? LINUX_BUILDS[process.arch] : null;
    if (!build) {
      console.error(`The AWS CLI is needed to create the Terraform state bucket, and Flarops can install it itself only on Linux (x86_64 or arm64). Install it (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html - on macOS, "brew install awscli"), then run init again.`);
      process.exit(1);
    }
    if (askQuestion) {
      const answer = String(await askQuestion('The AWS CLI is needed to create the Terraform state bucket and is not installed. Install a signature-verified copy into ~/.local (about 60 MB)? [Y/n] ')).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') {
        console.error('Install it yourself (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then run init again.');
        process.exit(1);
      }
    }
    console.log("Installing a signature-verified AWS CLI into ~/.local ...");

    // A random, 0700 directory: a fixed /tmp path could be pre-created by another local user.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flarops-aws-'));
    const zipPath = path.join(workDir, 'awscliv2.zip');
    const sigPath = path.join(workDir, 'awscliv2.zip.sig');
    const extractPath = path.join(workDir, 'extract');
    const gpgHome = path.join(workDir, 'gnupg');

    const assertPlainFile = (p, label) => {
      const st = fs.lstatSync(p);
      if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    };

    try {
      const curlFlags = ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--silent', '--show-error'];
      execFileSync('curl', [...curlFlags, `https://awscli.amazonaws.com/awscli-exe-linux-${build}.zip`, '-o', zipPath], { stdio: 'inherit' });
      execFileSync('curl', [...curlFlags, `https://awscli.amazonaws.com/awscli-exe-linux-${build}.zip.sig`, '-o', sigPath], { stdio: 'inherit' });
      assertPlainFile(zipPath, 'downloaded archive');
      assertPlainFile(sigPath, 'downloaded signature');

      fs.mkdirSync(gpgHome, { recursive: true, mode: 0o700 });
      const keyPath = path.join(workDir, 'aws-cli.asc');
      fs.writeFileSync(keyPath, AWS_CLI_PUBLIC_KEY, { mode: 0o600 });
      execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--quiet', '--import', keyPath], { stdio: 'pipe' });

      // gpg's exit code is not the check (it is 0 for an expired key); the VALIDSIG fingerprint is.
      let status;
      try {
        status = execFileSync('gpg', [
          '--homedir', gpgHome, '--batch', '--status-fd', '1', '--verify', sigPath, zipPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      } catch (gpgErr) {
        status = (gpgErr && gpgErr.stdout ? gpgErr.stdout.toString() : '');
      }

      const statusLine = (tag) => status.split('\n').find(line => line.startsWith('[GNUPG:] ' + tag + ' '));
      const validSig = statusLine('VALIDSIG');
      const signedBy = validSig ? validSig.split(/\s+/)[2] : null;
      // NO_PUBKEY/ERRSIG is what a key rotation looks like - not tampering.
      const unknownKey = statusLine('NO_PUBKEY') || statusLine('ERRSIG');

      if (signedBy && !AWS_CLI_KEY_FINGERPRINTS.includes(signedBy)) {
        throw new Error(rotationMessage(signedBy));
      }
      if (!signedBy && unknownKey) {
        throw new Error(rotationMessage(unknownKey.split(/\s+/)[2]));
      }
      if (!signedBy) {
        throw new Error('the downloaded archive does not match its AWS signature - it is corrupt or has been tampered with');
      }
      if (status.includes('[GNUPG:] EXPKEYSIG')) {
        console.warn("\x1b[33mNOTE: AWS's CLI signing key has expired. The signature is still valid and made by the expected key, so the download is accepted.\x1b[0m");
      }

      execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractPath], { stdio: 'ignore' });
      const installer = path.join(extractPath, 'aws', 'install');
      assertPlainFile(installer, 'installer');

      const localDir = path.join(os.homedir(), '.local');
      execFileSync(installer, ['-i', path.join(localDir, 'aws-cli'), '-b', path.join(localDir, 'bin')], { stdio: 'inherit' });

      console.log("AWS CLI installed successfully (signature verified).");
      return localAwsPath;
    } catch (err) {
      // Fail closed: an unverified CLI would be handed the AWS credentials.
      console.error("Failed to install a verified AWS CLI: " + (err && err.message ? err.message : err));
      console.error("Install it yourself (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and re-run.");
      // process.exit skips finally, so clean up here too.
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
      process.exit(1);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
  }
}

function sanitizeBucketName(name) {
  let sanitized = String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (sanitized.length < 3) sanitized = sanitized.padEnd(3, '0');
  if (sanitized.length > 63) sanitized = sanitized.substring(0, 63).replace(/-$/, '');
  return sanitized;
}

// A name for the state bucket; asked again while empty (an empty answer used to become "000").
async function askBucketName(askQuestion) {
  while (true) {
    const answer = String(await askQuestion('Enter a new bucket name (lowercase letters, digits and "-"): ')).trim();
    if (answer) return sanitizeBucketName(answer);
    console.log('a bucket name is required');
  }
}

function hardenStateBucket(awsCmd, bucket, env) {
  const steps = [
    ['versioning', ['s3api', 'put-bucket-versioning', '--bucket', bucket, '--versioning-configuration', 'Status=Enabled']],
    ['encryption', ['s3api', 'put-bucket-encryption', '--bucket', bucket, '--server-side-encryption-configuration',
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}']],
    ['public access block', ['s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true']],
  ];

  for (const [label, args] of steps) {
    try {
      execFileSync(awsCmd, args, { env, stdio: 'pipe' });
    } catch (err) {
      console.warn(`\x1b[33mWARNING: Could not enable ${label} on the Terraform state bucket "${bucket}". Enable it manually - the state file holds cluster credentials.\x1b[0m`);
    }
  }
}

function handleS3Bucket(awsCmd, bucketName, credentials, askQuestion, region = 'us-west-2') {
  const sanitized = sanitizeBucketName(bucketName);

  // Pass the CLI only what it needs from the environment.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AWS_ACCESS_KEY_ID: credentials.accessKey, AWS_SECRET_ACCESS_KEY: credentials.secretKey };

  // HeadBucket answers a wrong key and a bucket owned by another account with the same bare 403,
  // so the credentials are checked once via STS first.
  try {
    execFileSync(awsCmd, ['sts', 'get-caller-identity', '--region', region], { env, stdio: 'pipe' });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
    console.error("AWS UNAUTHORIZED Make sure your credentials are correct");
    if (stderr) console.error(stderr);
    process.exit(1);
  }

  return new Promise(async (resolve) => {
    let currentBucket = sanitized;

    while (true) {
      try {
        execFileSync(awsCmd, ['s3api', 'head-bucket', '--bucket', currentBucket], { env, stdio: 'pipe' });

        console.log(`The S3 bucket "${currentBucket}" for the Terraform state already exists, and these credentials can reach it.`);
        console.log('  Use it only if it is in YOUR AWS account (check the S3 console) and holds no other');
        console.log('  project\'s state at terraform.tfstate: its owner could read this state, which includes');
        console.log('  the cluster token, and two projects at one key overwrite each other.');
        const answer = await askQuestion(`Use "${currentBucket}"? [y/N] `);
        if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
          resolve({ bucket: currentBucket, warning: null });
          return;
        } else {
          currentBucket = await askBucketName(askQuestion);
        }
      } catch (error) {
        const stderr = error.stderr ? error.stderr.toString() : '';

        if (stderr.includes('InvalidAccessKeyId') || stderr.includes('SignatureDoesNotMatch') || stderr.includes('AuthFailure') || stderr.includes('ExpiredToken')) {
          console.error("AWS UNAUTHORIZED Make sure your credentials are correct");
          process.exit(1);
        } else if (stderr.includes('403') || stderr.includes('Forbidden')) {
          console.warn(`\x1b[33mBucket name "${currentBucket}" is already taken by another AWS account. S3 bucket names are global - choose a different one.\x1b[0m`);
          currentBucket = await askBucketName(askQuestion);
        } else if (stderr.includes('404') || stderr.includes('Not Found')) {
          try {
            console.log(`Creating S3 bucket: ${currentBucket} in ${region}...`);
            // us-east-1 rejects an explicit LocationConstraint.
            const createArgs = ['s3api', 'create-bucket', '--bucket', currentBucket, '--region', region];
            if (region !== 'us-east-1') {
              createArgs.push('--create-bucket-configuration', `LocationConstraint=${region}`);
            }
            execFileSync(awsCmd, createArgs, { env, stdio: 'pipe' });
            hardenStateBucket(awsCmd, currentBucket, env);
            resolve({ bucket: currentBucket, warning: null });
            return;
          } catch (createErr) {
            console.error(`Failed to create bucket ${currentBucket}.`);
            console.error(createErr.stderr ? createErr.stderr.toString() : createErr.message);
            currentBucket = await askBucketName(askQuestion);
          }
        } else {
          console.error(`Error checking bucket: ${stderr}`);
          currentBucket = await askBucketName(askQuestion);
        }
      }
    }
  });
}

module.exports = {
  getDefaultAWSCredentials,
  checkAwsAccess,
  ensureAwsCli,
  handleS3Bucket
};
