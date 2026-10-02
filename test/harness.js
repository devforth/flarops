// Runs `flarops init` non-interactively against a copy of a fixture: prompts, the AWS helper and
// `docker` are stubbed, everything else is real.

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const child_process = require('child_process');

const REPO = path.resolve(__dirname, '..');

const ANSWERS = {
  'docker registry': '',
  'username for': 'testuser',
  'password for': 'testpass',
  'project domain': 'example.test',
  'Cloudflare DNS': 'n',
  'AWS Access Key': '',
  'AWS Secret Access Key': 'secrettest',
  'AWS region': 'us-west-2',
  'refactor hardcoded frontend': 'n',
  'refactor hardcoded database': 'n',
  'refactor them': 'n',
  'bucket name': 'test-bucket',
  'want to use it': 'y',
};

function installStubs(extraAnswers) {
  readline.createInterface = () => ({
    question(q, cb) {
      let answer = '';
      for (const [needle, value] of Object.entries({ ...ANSWERS, ...(extraAnswers || {}) })) {
        if (q.includes(needle)) { answer = value; break; }
      }
      setImmediate(() => cb(answer));
    },
    close() {},
    _writeToOutput() {},
  });

  const awsPath = require.resolve(path.join(REPO, 'utils/awsHelper.js'));
  require(awsPath);
  require.cache[awsPath].exports = {
    getDefaultAWSCredentials: () => ({ accessKey: 'AKIATEST', secretKey: 'secrettest' }),
    ensureAwsCli: () => '/bin/true',
    handleS3Bucket: async (_cmd, name) => ({
      bucket: String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      warning: null,
    }),
  };

  const realExecFile = child_process.execFileSync;
  child_process.execFileSync = function (file, args, opts) {
    if (String(file) === 'docker') return Buffer.from('');
    return realExecFile.apply(child_process, arguments);
  };
}

async function generate(fixtureDir, extraAnswers) {
  // The directory's basename becomes projectName, so it must be stable for snapshots.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'flarops-test-'));
  const work = path.join(parent, path.basename(fixtureDir));
  fs.cpSync(fixtureDir, work, { recursive: true });
  child_process.execFileSync('git', ['init', '-q'], { cwd: work });
  // .env and .env.local stay out of git, as in a real project: init treats committed values as public.
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.env\n.env.local\n');
  child_process.execFileSync('git', ['add', '-A'], { cwd: work, stdio: 'ignore' });
  child_process.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'],
    { cwd: work, stdio: 'ignore' });

  installStubs(extraAnswers);
  // Reset module-level state between generations.
  require(path.join(REPO, 'utils/composeFiles.js')).approveVariantComposeFile(null);

  const lines = [];
  const capture = (stream) => {
    const original = process[stream].write.bind(process[stream]);
    process[stream].write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
    return () => { process[stream].write = original; };
  };
  const restoreOut = capture('stdout');
  const restoreErr = capture('stderr');

  const cwd = process.cwd();
  process.chdir(work);
  let ok = true;
  let error = null;
  try {
    delete require.cache[require.resolve(path.join(REPO, 'bin/commands/init.js'))];
    const init = require(path.join(REPO, 'bin/commands/init.js'));
    await init();
  } catch (e) {
    ok = false;
    error = e;
  } finally {
    process.chdir(cwd);
    restoreOut();
    restoreErr();
  }

  return { dir: work, parent, log: lines.join(''), ok, error };
}

module.exports = { generate };
