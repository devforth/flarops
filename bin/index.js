#!/usr/bin/env node

const command = process.argv[2];

function showHelp() {
  console.log(
    "Available commands:\n" +
    "  init         Initialize terraform configuration\n"
  );
}

(async () => {
  switch (command) {
    case 'init': {
      const initCmd = require('./commands/init.js');
      await initCmd();
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
