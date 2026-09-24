// `flarops sync` - remove generated chart templates that no longer correspond
// to anything in the deployment.
//
// `flarops init` writes one Helm template per service but never deletes one.
// Drop a service from docker-compose and re-run init, and values.yaml loses it
// while deploy/helm/templates/<name>.yaml stays behind - still referencing
// .Values.additionalServicesIndices."<name>", which is now absent. Helm does
// not fail that object alone: "index of untyped nil" aborts rendering of the
// WHOLE chart, so one removed service takes the entire deployment with it.
//
// Deleting files is deliberately not something init does on its own. This
// command is the explicit gesture: it reads the deployment that exists and
// removes only what that deployment can no longer reference.

const fs = require('fs');
const path = require('path');

// Present in every generated chart, whatever the project contains.
const ALWAYS_PRESENT = new Set([
  '_helpers.tpl',
  '01-ingress.yaml',
  'secret.yaml',
  'registry-secret.yaml',
  'dashboard.yaml',
]);

// Reads the handful of values.yaml keys this needs without a YAML parser -
// Flarops has no dependencies and this file is its own generated output, so
// its shape is known exactly.
function readGeneratedValues(valuesPath) {
  const text = fs.readFileSync(valuesPath, 'utf8');
  const flag = (key) => new RegExp('^' + key + ':\\s*true\\s*$', 'm').test(text);

  // "  - name: <x>" entries under a given top-level list key.
  const namesUnder = (listKey) => {
    const start = text.search(new RegExp('^' + listKey + ':\\s*$', 'm'));
    if (start === -1) return [];
    const rest = text.slice(start).split('\n').slice(1);
    const names = [];
    for (const line of rest) {
      if (/^\S/.test(line)) break;              // next top-level key
      const m = line.match(/^\s*-\s*name:\s*"?([A-Za-z0-9._-]+)"?\s*$/);
      if (m) names.push(m[1]);
    }
    return names;
  };

  // An additionalService with its own database renders a second file.
  const withOwnDb = [];
  for (const name of namesUnder('additionalServices')) {
    const block = text.split(new RegExp('^\\s*-\\s*name:\\s*"?' + name + '"?\\s*$', 'm'))[1] || '';
    const upToNext = block.split(/^\s*-\s*name:/m)[0];
    if (/^\s+db:\s*$/m.test(upToNext)) withOwnDb.push(name);
  }

  return {
    hasBackend: flag('hasBackend'),
    hasFrontend: flag('hasFrontend'),
    hasDb: flag('hasDb'),
    additionalServices: namesUnder('additionalServices'),
    additionalServicesWithOwnDb: withOwnDb,
    supportServices: namesUnder('supportServices'),
  };
}

function expectedTemplates(values) {
  const expected = new Set(ALWAYS_PRESENT);
  if (values.hasBackend) expected.add('api.yaml');
  if (values.hasFrontend) expected.add('frontend.yaml');
  if (values.hasDb) expected.add('database.yaml');
  for (const name of values.additionalServices) expected.add(`${name}.yaml`);
  for (const name of values.additionalServicesWithOwnDb) expected.add(`${name}-db.yaml`);
  for (const name of values.supportServices) expected.add(`support-${name}.yaml`);
  return expected;
}

// Exported so `init` can warn about orphans without removing anything.
function findOrphanTemplates(currentDir) {
  const templatesDir = path.join(currentDir, 'deploy', 'helm', 'templates');
  const valuesPath = path.join(currentDir, 'deploy', 'helm', 'values.yaml');
  if (!fs.existsSync(templatesDir) || !fs.existsSync(valuesPath)) return null;

  const expected = expectedTemplates(readGeneratedValues(valuesPath));
  const present = fs.readdirSync(templatesDir).filter(f => /\.(yaml|tpl)$/.test(f));
  return { templatesDir, orphans: present.filter(f => !expected.has(f)) };
}

module.exports = async function sync() {
  const currentDir = process.cwd();

  const found = findOrphanTemplates(currentDir);
  if (!found) {
    console.error('\x1b[31mERROR: No generated chart found here. Run "flarops init" first.\x1b[0m');
    process.exit(1);
  }

  if (found.orphans.length === 0) {
    console.log('Chart is in sync - every template matches a service in deploy/helm/values.yaml.');
    return;
  }

  console.log('These templates no longer match anything in deploy/helm/values.yaml:');
  for (const f of found.orphans) console.log(`  ${f}`);
  console.log('');

  for (const f of found.orphans) {
    fs.unlinkSync(path.join(found.templatesDir, f));
  }
  console.log(`\x1b[32mRemoved ${found.orphans.length} stale template(s).\x1b[0m`);
  console.log('Commit deploy/helm/ and redeploy.');
};

module.exports.findOrphanTemplates = findOrphanTemplates;
