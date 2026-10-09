// The dashboard's sources as they go into a generated project's deploy/dashboard: no locally built
// binary, no tests, no SQLite runtime state, and no comments. init writes them; sync keeps them
// current, so a dashboard fix reaches projects generated before it.

const fs = require('fs');
const path = require('path');
const { stripGoComments, stripHashComments, stripHtmlComments } = require('./stripComments.js');

const SOURCE_DIR = path.join(__dirname, '..', 'dashboard');

function included(rel) {
  const base = path.basename(rel);
  if (rel === 'dashboard') return false; // a locally built binary
  if (base.endsWith('_test.go')) return false;
  if (/\.db(-wal|-shm)?$/.test(base)) return false;
  return true;
}

// [{ file, content }] under destDir; text files as strings, anything else as a Buffer.
function renderDashboardFiles(destDir) {
  if (!fs.existsSync(SOURCE_DIR)) return [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return walk(SOURCE_DIR)
    .map(abs => path.relative(SOURCE_DIR, abs))
    .filter(included)
    .sort()
    .map(rel => {
      const strip = rel.endsWith('.go') ? stripGoComments
        : path.basename(rel) === 'Dockerfile' ? stripHashComments
          : rel.endsWith('.html') ? stripHtmlComments : null;
      const raw = fs.readFileSync(path.join(SOURCE_DIR, rel));
      return { file: path.join(destDir, rel), content: strip ? strip(raw.toString('utf8')) : raw };
    });
}

module.exports = { renderDashboardFiles, included };
