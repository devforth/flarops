const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

function getDefaultAWSCredentials() {
  try {
    const credPath = path.join(os.homedir(), '.aws', 'credentials');
    if (fs.existsSync(credPath)) {
      const content = fs.readFileSync(credPath, 'utf8');
      
      let inDefault = false;
      let accessKey = '';
      let secretKey = '';

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '[default]') {
          inDefault = true;
          continue;
        } else if (trimmed.startsWith('[')) {
          inDefault = false;
        }

        if (inDefault) {
          if (trimmed.startsWith('aws_access_key_id')) {
            accessKey = trimmed.split('=')[1].trim();
          } else if (trimmed.startsWith('aws_secret_access_key')) {
            secretKey = trimmed.split('=')[1].trim();
          }
        }
      }

      if (accessKey && secretKey) {
        return { accessKey, secretKey };
      }
    }
  } catch (err) {
    // Ignore errors
  }
  return null;
}

// The AWS CLI Team's OpenPGP public key, embedded rather than fetched so
// verification does not depend on a keyserver being reachable - or on a
// keyserver being honest. Its fingerprint is pinned separately below and
// checked against what the signature actually claims, so substituting this
// block alone cannot make a forged archive verify.
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

// Published by AWS in the CLI User Guide. This constant, not the exit code
// of gpg, is what decides whether the download is trusted.
//
// A LIST, so that a key rotation can be handled by adding the new fingerprint
// beside the old one instead of replacing it - during a changeover AWS may
// still be serving archives signed by either. Pinning the signer does NOT tie
// this to an AWS CLI version: the same key has signed every release from
// 2.15.0 to current, and the download URL is the rolling "latest" one, so new
// CLI versions keep verifying with no change here. Only an actual key
// rotation requires touching this file.
const AWS_CLI_KEY_FINGERPRINTS = ['FB5DB77FD5C118B80511ADA8A6310ACC4672475C'];

// A good signature by a key this build does not know is either a substituted
// key or a legitimate rotation by AWS, and nothing here can tell those apart -
// so it refuses, and reports exactly what it saw so the difference is settled
// against AWS's published fingerprint rather than guessed at.
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
    // Reject anything living inside the project directory being scanned (e.g. a
    // repo-planted node_modules/.bin/aws or ./aws executable) - only trust
    // system-installed binaries outside the project tree.
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
    // A few AWS CLI builds print the version banner to stderr and/or exit non-zero;
    // fall back to checking whatever output we did capture before giving up.
    const combined = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    return /aws-cli\//.test(combined);
  }
}

function ensureAwsCli() {
  // Resolve `aws` from PATH exactly once, to an absolute, canonicalized path -
  // never return the bare string 'aws', which would be re-resolved through
  // PATH (and thus hijackable by a repo-planted binary) on every subsequent call.
  // Location alone isn't proof it's actually the AWS CLI though (e.g. some
  // systems have an unrelated "aws" snap/alias on PATH that fails on every
  // real subcommand) - verify with `--version` before trusting it.
  try {
    const resolvedFromPath = execSync('command -v aws', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const trusted = resolveTrustedAwsPath(resolvedFromPath);
    if (trusted && looksLikeAwsCli(trusted)) return trusted;
    if (trusted) {
      console.warn(`\x1b[33mWARNING: Found "aws" on your PATH at ${trusted}, but it doesn't behave like the real AWS CLI ("aws --version" didn't report aws-cli). Ignoring it and installing a trusted copy instead.\x1b[0m`);
    }
  } catch (e) { /* not found on PATH */ }

  {
    // Check if it's in ~/.local/bin/aws
    const localAwsPath = path.join(os.homedir(), '.local', 'bin', 'aws');
    if (fs.existsSync(localAwsPath) && looksLikeAwsCli(localAwsPath)) {
      return fs.realpathSync(localAwsPath);
    }

    console.log("AWS CLI not found (or not verified as genuine). Installing a trusted copy locally...");

    // A fresh directory with a random name, created 0700 by mkdtempSync. The
    // old fixed /tmp/awscli-install was guessable, so any local user could
    // pre-create it - as a directory they owned, or as a symlink elsewhere -
    // and swap the installer between unzip and exec. A name nobody can predict
    // removes the race rather than trying to win it.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flarops-aws-'));
    const zipPath = path.join(workDir, 'awscliv2.zip');
    const sigPath = path.join(workDir, 'awscliv2.zip.sig');
    const extractPath = path.join(workDir, 'extract');
    const gpgHome = path.join(workDir, 'gnupg');

    // Nothing inside workDir may be anything but a plain file or directory.
    // Cheap to assert, and it is the property every step below relies on.
    const assertPlainFile = (p, label) => {
      const st = fs.lstatSync(p);
      if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    };

    try {
      const curlFlags = ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--silent', '--show-error'];
      execFileSync('curl', [...curlFlags, 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip', '-o', zipPath], { stdio: 'inherit' });
      execFileSync('curl', [...curlFlags, 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip.sig', '-o', sigPath], { stdio: 'inherit' });
      assertPlainFile(zipPath, 'downloaded archive');
      assertPlainFile(sigPath, 'downloaded signature');

      // Verified in a keyring of its own, so this neither reads nor writes the
      // user's real GnuPG home.
      fs.mkdirSync(gpgHome, { recursive: true, mode: 0o700 });
      const keyPath = path.join(workDir, 'aws-cli.asc');
      fs.writeFileSync(keyPath, AWS_CLI_PUBLIC_KEY, { mode: 0o600 });
      execFileSync('gpg', ['--homedir', gpgHome, '--batch', '--quiet', '--import', keyPath], { stdio: 'pipe' });

      // The exit code of "gpg --verify" is NOT the check: it is 0 for a good
      // signature made by an EXPIRED key, and AWS's own signing key expired on
      // 2026-07-07 while it kept signing releases. What matters is the
      // machine-readable VALIDSIG line, which names the fingerprint that
      // actually made the signature - compared here against the pinned one.
      // gpg exits non-zero for a bad signature AND for a signature it has no
      // key for, so the status output has to be read in both cases - not just
      // the happy one. Its stdout is on the error object when it throws.
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
      // A key we do not hold reports NO_PUBKEY/ERRSIG and never reaches
      // VALIDSIG - which is exactly what an AWS key rotation looks like from
      // here, and must not be reported as tampering.
      const unknownKey = statusLine('NO_PUBKEY') || statusLine('ERRSIG');

      if (signedBy && !AWS_CLI_KEY_FINGERPRINTS.includes(signedBy)) {
        throw new Error(rotationMessage(signedBy));
      }
      if (!signedBy && unknownKey) {
        throw new Error(rotationMessage(unknownKey.split(/\s+/)[2]));
      }
      if (!signedBy) {
        // A signature we DO hold the key for, that does not match the bytes.
        // This is corruption or tampering, never a rotation.
        throw new Error('the downloaded archive does not match its AWS signature - it is corrupt or has been tampered with');
      }
      if (status.includes('[GNUPG:] EXPKEYSIG')) {
        // Expiry is an operational lapse on AWS's side, not evidence of
        // compromise: the signature is still cryptographically valid and made
        // by the pinned key. Worth saying out loud, not worth refusing over.
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
      // Fail closed. An unverified AWS CLI would run with the credentials this
      // tool is about to hand it, so "install it anyway" is not an option.
      console.error("Failed to install a verified AWS CLI: " + (err && err.message ? err.message : err));
      console.error("Install it yourself (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and re-run.");
      // Cleaned up HERE rather than only in finally: process.exit terminates
      // immediately and finally never runs, which left the ~60MB download
      // behind on every failed attempt.
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

// A Terraform state bucket holds the k3s join token, the deploy public key and
// the full shape of the infrastructure. Created bare it had no versioning (a
// bad apply or a delete is unrecoverable), no encryption at rest, and no block
// on public access. Applied only to buckets Flarops creates itself - a bucket
// the operator chose to reuse is theirs, and silently changing its policies
// could affect whatever else lives in it.
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

  // Pass only what the AWS CLI actually needs, instead of the full parent
  // environment, to limit what an untrusted/hijacked child process could read.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, AWS_ACCESS_KEY_ID: credentials.accessKey, AWS_SECRET_ACCESS_KEY: credentials.secretKey };

  return new Promise(async (resolve) => {
    let currentBucket = sanitized;

    while (true) {
      try {
        execFileSync(awsCmd, ['s3api', 'head-bucket', '--bucket', currentBucket], { env, stdio: 'pipe' });

        // Exists and we have access
        const answer = await askQuestion(`Bucket [${currentBucket}] is already exist, are you sure you want to use it? [y/N]: `);
        if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
          resolve({
            bucket: currentBucket,
            warning: `\x1b[33mWARNING: Make sure that this bucket does not currently store the state of any other infrastructure, so as not to corrupt it. If you think it would be better to use a different bucket, create it in the AWS console and manually update the deploy/terraform/main.tf file.\x1b[0m`
          });
          return;
        } else {
          currentBucket = sanitizeBucketName((await askQuestion('Enter new bucket name: ')).trim());
        }
      } catch (error) {
        const stderr = error.stderr ? error.stderr.toString() : '';

        if (stderr.includes('403') || stderr.includes('Forbidden') || stderr.includes('InvalidAccessKeyId') || stderr.includes('SignatureDoesNotMatch') || stderr.includes('AuthFailure')) {
          console.error("AWS UNAUTHORIZED Make sure your credentials are correct");
          process.exit(1);
        } else if (stderr.includes('404') || stderr.includes('Not Found')) {
          // Doesn't exist, we can create it
          try {
            console.log(`Creating S3 bucket: ${currentBucket} in ${region}...`);
            // us-east-1 is the one region that rejects an explicit
            // LocationConstraint, so it must be created without one.
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
            currentBucket = sanitizeBucketName((await askQuestion('Enter new bucket name: ')).trim());
          }
        } else {
          // Some other error
          console.error(`Error checking bucket: ${stderr}`);
          currentBucket = sanitizeBucketName((await askQuestion('Enter new bucket name: ')).trim());
        }
      }
    }
  });
}

module.exports = {
  getDefaultAWSCredentials,
  ensureAwsCli,
  handleS3Bucket
};
