// Runs `flarops init` non-interactively against a copy of a fixture.
//
// init is one 3000-line function that prompts, shells out to docker and talks
// to AWS, so nothing in it could be exercised without a TTY and credentials -
// which is why every template change until now was verified by hand, or not at
// all. This stubs exactly three things (the prompts, the AWS helper, and the
// docker binary) and leaves the entire analysis and generation path real.

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const child_process = require('child_process');

const REPO = path.resolve(__dirname, '..');

// Matched against the prompt text, first hit wins. Refactor prompts answer "n"
// so a fixture's source is never rewritten under the test.
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
      // A per-run override, so a test can answer one question differently
      // without every fixture inheriting that answer.
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

  // `docker login` is the only binary init runs that needs a daemon.
  const realExecFile = child_process.execFileSync;
  child_process.execFileSync = function (file, args, opts) {
    if (String(file) === 'docker') return Buffer.from('');
    return realExecFile.apply(child_process, arguments);
  };
}

// Copies a fixture to a scratch directory, makes it a git repo (init requires
// one) and runs the generator in it. Returns { dir, log, ok }.
async function generate(fixtureDir, extraAnswers) {
  // The working directory's BASENAME becomes projectName, which appears in the
  // chart, the workflows and the state bucket name - so a random mkdtemp name
  // would make every generated file differ between runs and snapshots
  // worthless. The random part goes in the parent directory instead.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'flarops-test-'));
  const work = path.join(parent, path.basename(fixtureDir));
  fs.cpSync(fixtureDir, work, { recursive: true });
  child_process.execFileSync('git', ['init', '-q'], { cwd: work });
  child_process.execFileSync('git', ['add', '-A'], { cwd: work, stdio: 'ignore' });
  child_process.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'],
    { cwd: work, stdio: 'ignore' });

  installStubs(extraAnswers);
  // Module-level state in the generator that would otherwise carry from one
  // generation to the next.
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
