#!/usr/bin/env node

const { version } = require('../package.json');
const { closest } = require('../utils/closest.js');

const COMMANDS = {
  init: {
    summary: 'Analyze this repository and generate the deployment (run once, from the repository root)',
    usage: 'npx flarops init [--verbose]',
    details: [
      'Reads docker-compose, .env files and the source, asks a few questions (registry, domain,',
      'Cloudflare, AWS), and writes flarops.yaml, deploy/, the GitHub workflows, werf.yaml and a',
      'Flarops section in AGENTS.md. It refuses to run where flarops.yaml already exists.',
      '',
      '  --verbose   Also print what it found and decided (always written to deploy/flarops-init.log).',
    ],
  },
  sync: {
    summary: 'Apply flarops.yaml to the generated deployment',
    usage: 'npx flarops sync [--check]',
    details: [
      'Rewrites the chart, werf.yaml, the workflows and the dashboard to match flarops.yaml, and',
      'prints what changed and what to do next.',
      '',
      '  --check   Write nothing: print what sync would change, and exit 1 if anything would.',
    ],
  },
  'dashboard-password': {
    summary: 'Issue a new dashboard password (the old one cannot be recovered)',
    usage: 'npx flarops dashboard-password',
    details: [
      'Writes a new DASHBOARD_PASSWORD_HASH into deploy/.env and shows the password once. Copy the',
      'hash into the GitHub secret of the same name and redeploy for it to take effect.',
    ],
  },
};

function showHelp() {
  console.log(`flarops ${version}\n\nUsage: npx flarops <command>\n\nCommands:`);
  for (const [name, c] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(20)}${c.summary}`);
  console.log('\nRun "npx flarops <command> --help" for details. To change the deployment, edit flarops.yaml');
  console.log('and run "npx flarops sync"; its field reference is the comment block at the end of the file.');
}

function showCommandHelp(name) {
  const c = COMMANDS[name];
  console.log(`Usage: ${c.usage}\n\n${c.summary}.\n\n${c.details.join('\n')}`);
}

// The closest known command, for a typo.
const suggest = (word) => closest(word, Object.keys(COMMANDS));

const [command, ...args] = process.argv.slice(2);
const wantsHelp = args.includes('--help') || args.includes('-h');

(async () => {
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(version);
    return;
  }
  if (!COMMANDS[command]) {
    const guess = suggest(command);
    console.error(`Unknown command "${command}".${guess ? ` Did you mean "${guess}"?` : ''}\n`);
    showHelp();
    process.exit(1);
  }
  // Help never runs the command: "sync --help" must not write files.
  if (wantsHelp) {
    showCommandHelp(command);
    return;
  }
  const known = { init: ['--verbose'], sync: ['--check'], 'dashboard-password': [] }[command];
  const unknown = args.filter(a => !known.includes(a));
  if (unknown.length > 0) {
    console.error(`Unknown option ${unknown.map(a => `"${a}"`).join(', ')} for "${command}".\n`);
    showCommandHelp(command);
    process.exit(1);
  }

  if (command === 'init') await require('./commands/init.js')({ verbose: args.includes('--verbose') });
  if (command === 'sync') await require('./commands/sync.js')({ check: args.includes('--check') });
  if (command === 'dashboard-password') await require('./commands/dashboardPassword.js')();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
