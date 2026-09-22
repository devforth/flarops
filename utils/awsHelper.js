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
    const tmpDir = os.tmpdir();
    const zipPath = path.join(tmpDir, 'awscliv2.zip');
    const extractPath = path.join(tmpDir, 'awscli-install');
    
    try {
      execFileSync('curl', ['https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip', '-o', zipPath], { stdio: 'inherit' });
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractPath], { stdio: 'ignore' });
      
      const localDir = path.join(os.homedir(), '.local');
      execFileSync(path.join(extractPath, 'aws', 'install'), ['-i', path.join(localDir, 'aws-cli'), '-b', path.join(localDir, 'bin')], { stdio: 'inherit' });
      
      console.log("AWS CLI installed successfully.");
      return localAwsPath;
    } catch (err) {
      console.error("Failed to install AWS CLI. Please install it manually.");
      process.exit(1);
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
