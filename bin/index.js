#!/usr/bin/env node

const command = process.argv[2];

function showHelp() {
  console.log(
    "Available commands:\n" +
    "  init         Analyze this repository and generate the deployment stack\n" +
    "  sync         Apply flarops.yaml to the generated deployment\n"
  );
}

(async () => {
  switch (command) {
    case 'init': {
      const initCmd = require('./commands/init.js');
      await initCmd();
      break;
    }
    case 'sync': {
      const syncCmd = require('./commands/sync.js');
      await syncCmd();
      break;
    }
    default:
      showHelp();
      break;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
