// The directory holding flarops.yaml: the current one or the nearest above it, so a command run from
// a subdirectory of the project works on the project instead of failing.

const fs = require('fs');
const path = require('path');

function findProjectRoot(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'flarops.yaml'))) return dir;
    // A repository root ends the search: a flarops.yaml above it belongs to another project.
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return null;
  }
}

// Moves into the project root when run from below it, and says so. False when there is no project.
function enterProjectRoot() {
  const root = findProjectRoot();
  if (!root) return false;
  if (root !== process.cwd()) {
    console.log(`Using ${path.join(path.relative(process.cwd(), root), 'flarops.yaml')} (the project root is ${root}).`);
    process.chdir(root);
  }
  return true;
}

module.exports = { findProjectRoot, enterProjectRoot };
