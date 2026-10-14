// Which file is the docker-compose file: conventional names first, then a variant name (with the
// operator's approval), at the root or in a few usual subdirectories.

const fs = require('fs');
const path = require('path');

// In the order docker compose itself looks for them.
const CANONICAL = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const VARIANT = /^(docker-)?compose[.-][A-Za-z0-9_.-]*\.ya?ml$/i;

// Whether the operator approved a variant compose file; null until asked.
let variantApproved = null;
// The one the operator chose among several, as an absolute path.
let chosenVariant = null;

// null resets it: the test harness runs many generations in one process. A string approves that file
// alone (a path relative to the repository root, or absolute).
function approveVariantComposeFile(approved, baseDir) {
  chosenVariant = typeof approved === 'string' ? path.resolve(baseDir || process.cwd(), approved) : null;
  variantApproved = approved === null ? null : !!approved;
}

// A production variant is the likelier base for a deployment than a development one.
const PRODUCTION_VARIANT = /(^|[.-])prod(uction)?([.-]|$)/i;
const productionFirst = (names) => [...names.filter(n => PRODUCTION_VARIANT.test(path.basename(n).replace(/\.ya?ml$/i, ''))),
  ...names.filter(n => !PRODUCTION_VARIANT.test(path.basename(n).replace(/\.ya?ml$/i, '')))];

const SUBDIRS = ['deploy', 'docker', '.docker', 'compose', 'infra', 'ops'];

function namesIn(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

// Paths come back relative to baseDir. Paths inside a compose file resolve against its own
// directory (composeBaseDir).
function listComposeFiles(baseDir) {
  const found = [];
  const collect = (dir, prefix) => {
    const entries = namesIn(dir);
    const present = new Set(entries);
    const canonical = CANONICAL.filter(name => present.has(name)).map(name => prefix + name);
    const variants = entries.filter(name => VARIANT.test(name)).sort().map(name => prefix + name);
    return { canonical, variants };
  };

  const root = collect(baseDir, '');
  if (root.canonical.length > 0) return root.canonical;
  found.push(...root.variants);

  for (const sub of SUBDIRS) {
    const { canonical, variants } = collect(path.join(baseDir, sub), sub + '/');
    if (canonical.length > 0) return canonical;
    found.push(...variants);
  }

  if (variantApproved === false) return [];
  if (chosenVariant) {
    const chosen = found.filter(f => path.resolve(baseDir, f) === chosenVariant);
    if (chosen.length > 0) return chosen;
  }

  return productionFirst(found);
}

function composeBaseDir(baseDir, composeFile) {
  return path.dirname(path.resolve(baseDir, composeFile));
}

function isVariantComposeFile(name) {
  return !!name && !CANONICAL.includes(path.basename(name));
}

module.exports = { listComposeFiles, isVariantComposeFile, approveVariantComposeFile, composeBaseDir, CANONICAL };
