// Which file in this repository is the docker-compose file.
//
// Every analyzer used to carry its own copy of the same four names and try
// them in order. That worked until a project named its compose file anything
// else - "docker-compose-dev.yaml" is an ordinary choice, and for a repository
// whose ONLY compose file is named that, the four-name list meant Flarops read
// no compose file at all. It did not fail: it discovered no services, no
// support components and no build contexts, and generated a deployment
// containing the backend, the frontend and nothing else, silently. A ten
// service stack came out as three.
//
// So: the canonical names first, exactly as before. Only when none of them
// exists does the fallback look at what is actually there. Reading the one
// compose file a project has is strictly better than reading none, and the
// caller says out loud which file it used.

const fs = require('fs');
const path = require('path');

const CANONICAL = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];

// "docker-compose-dev.yaml", "docker-compose.prod.yml", "compose.local.yaml".
// Anchored so it cannot match an unrelated YAML file that merely mentions the
// word somewhere in its name.
const VARIANT = /^(docker-)?compose[.-][A-Za-z0-9_.-]*\.ya?ml$/i;

// Returns the candidate filenames present in baseDir, best first. Sync because
// every caller needs it and half of them are synchronous; it is one readdir of
// the repository root.
// Whether the operator agreed to base the deployment on a non-conventionally
// named compose file. null until asked.
//
// Held here, as one answer for the whole run, because the question is asked
// once but the answer is needed in eight places: every analyzer resolves the
// compose file independently, and threading a flag through all of them and
// their callers would mean the one that was missed silently ignores the
// operator's "no".
let variantApproved = null;

// null resets it to "not asked", which is what a fresh run starts from. The
// test harness runs many generations in one process, and an answer leaking
// from one into the next would make a fixture's result depend on which
// fixtures ran before it.
function approveVariantComposeFile(approved) {
  variantApproved = approved === null ? null : !!approved;
}

// Directories a compose file is routinely kept in when it is not at the root.
// Searched in this order, after the root itself. Deliberately short: the point
// is to find the file a project actually has, not to go hunting.
const SUBDIRS = ['deploy', 'docker', '.docker', 'compose', 'infra', 'ops'];

function namesIn(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

// Returns candidate compose files as paths RELATIVE TO baseDir, best first -
// so a file kept one directory down comes back as "deploy/docker-compose.yml",
// not just its name. Everything that resolves a path out of such a file has to
// resolve it against the file's own directory, which is how docker-compose
// itself reads them: "context: ../api" in deploy/ means the repository's api/.
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
    // A conventionally named file one directory down still beats a variant at
    // the root - the name is the stronger signal, not the depth.
    if (canonical.length > 0) return canonical;
    found.push(...variants);
  }

  // Declined: this repository is treated as having no compose file at all,
  // which is what it has as far as the operator is concerned.
  if (variantApproved === false) return [];

  return found;
}

// The directory relative paths inside a compose file resolve against.
function composeBaseDir(baseDir, composeFile) {
  return path.dirname(path.resolve(baseDir, composeFile));
}

// True when the file being used is not one of the conventional names, so the
// caller can say which one it picked.
function isVariantComposeFile(name) {
  return !!name && !CANONICAL.includes(path.basename(name));
}

module.exports = { listComposeFiles, isVariantComposeFile, approveVariantComposeFile, composeBaseDir, CANONICAL };
