const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

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

function ensureAwsCli() {
  // Check if aws is in PATH
  try {
    execSync('command -v aws', { stdio: 'ignore' });
    return 'aws';
  } catch (e) {
    // Check if it's in ~/.local/bin/aws
    const localAwsPath = path.join(os.homedir(), '.local', 'bin', 'aws');
    if (fs.existsSync(localAwsPath)) {
      return localAwsPath;
    }

    console.log("AWS CLI not found. Installing locally...");
    const tmpDir = os.tmpdir();
    const zipPath = path.join(tmpDir, 'awscliv2.zip');
    const extractPath = path.join(tmpDir, 'awscli-install');
    
    try {
      execSync(`curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "${zipPath}"`, { stdio: 'inherit' });
      execSync(`unzip -q -o "${zipPath}" -d "${extractPath}"`, { stdio: 'ignore' });
      
      const localDir = path.join(os.homedir(), '.local');
      const installCmd = `${path.join(extractPath, 'aws', 'install')} -i ${path.join(localDir, 'aws-cli')} -b ${path.join(localDir, 'bin')}`;
      execSync(installCmd, { stdio: 'inherit' });
      
      console.log("AWS CLI installed successfully.");
      return localAwsPath;
    } catch (err) {
      console.error("Failed to install AWS CLI. Please install it manually.");
      process.exit(1);
    }
  }
}

function handleS3Bucket(awsCmd, bucketName, credentials, askQuestion) {
  let sanitized = bucketName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (sanitized.length < 3) sanitized = sanitized.padEnd(3, '0');
  if (sanitized.length > 63) sanitized = sanitized.substring(0, 63).replace(/-$/, '');

  const env = { ...process.env, AWS_ACCESS_KEY_ID: credentials.accessKey, AWS_SECRET_ACCESS_KEY: credentials.secretKey };
  
  return new Promise(async (resolve) => {
    let currentBucket = sanitized;
    
    while (true) {
      try {
        execSync(`${awsCmd} s3api head-bucket --bucket ${currentBucket}`, { env, stdio: 'pipe' });
        
        // Exists and we have access
        const answer = await askQuestion(`Bucket [${currentBucket}] is already exist, are you sure you want to use it? [y/N]: `);
        if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
          resolve({
            bucket: currentBucket,
            warning: `\x1b[33mWARNING: Make sure that this bucket does not currently store the state of any other infrastructure, so as not to corrupt it. If you think it would be better to use a different bucket, create it in the AWS console and manually update the deploy/terraform/main.tf file.\x1b[0m`
          });
          return;
        } else {
          currentBucket = await askQuestion('Enter new bucket name: ');
          currentBucket = currentBucket.trim();
        }
      } catch (error) {
        const stderr = error.stderr ? error.stderr.toString() : '';
        
        if (stderr.includes('403') || stderr.includes('Forbidden') || stderr.includes('InvalidAccessKeyId') || stderr.includes('SignatureDoesNotMatch') || stderr.includes('AuthFailure')) {
          console.error("AWS UNAUTHORIZED Make sure your credentials are correct");
          process.exit(1);
        } else if (stderr.includes('404') || stderr.includes('Not Found')) {
          // Doesn't exist, we can create it
          try {
            console.log(`Creating S3 bucket: ${currentBucket} in us-west-2...`);
            execSync(`${awsCmd} s3api create-bucket --bucket ${currentBucket} --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2`, { env, stdio: 'pipe' });
            resolve({ bucket: currentBucket, warning: null });
            return;
          } catch (createErr) {
            console.error(`Failed to create bucket ${currentBucket}.`);
            console.error(createErr.stderr ? createErr.stderr.toString() : createErr.message);
            currentBucket = await askQuestion('Enter new bucket name: ');
            currentBucket = currentBucket.trim();
          }
        } else {
          // Some other error
          console.error(`Error checking bucket: ${stderr}`);
          currentBucket = await askQuestion('Enter new bucket name: ');
          currentBucket = currentBucket.trim();
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
