// End-to-end checks for `flarops sync`.
//
// Sync's contract is that flarops.yaml is the source of truth: editing a
// parameter changes the deployment, declaring a service creates one from the
// same templates a discovered service is built from, and removing one takes it
// away. Each of those is checked against the files that actually get deployed,
// not against sync's own reporting.
//
// The real CLI is driven in a child process because sync exits the process on
// bad input, which inside the runner would take the suite with it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'index.js');

function runSync(dir) {
  try {
    return { status: 0, out: execFileSync('node', [CLI, 'sync'], { cwd: dir, stdio: 'pipe' }).toString() };
  } catch (e) {
    return { status: e.status, out: (e.stdout || Buffer.from('')).toString(), err: (e.stderr || Buffer.from('')).toString() };
  }
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

// Replaces one "key: value" line inside a named top-level service block.
function editService(dir, service, key, value) {
  const file = path.join(dir, 'flarops.yaml');
  const text = fs.readFileSync(file, 'utf8');
  // The first block starts at offset 0 with no newline before it.
  const at = text.startsWith(`${service}:\n`) ? 0 : text.indexOf(`\n${service}:\n`) + 1;
  if (at === 0 && !text.startsWith(`${service}:\n`)) throw new Error(`no ${service} block in flarops.yaml`);
  const head = text.slice(0, at);
  const rest = text.slice(at);
  const endRel = rest.slice(1).search(/\n[A-Za-z#]/);
  const block = endRel === -1 ? rest : rest.slice(0, endRel + 2);
  const tail = endRel === -1 ? '' : rest.slice(endRel + 2);
  const edited = new RegExp(`^(  ${key}:).*$`, 'm').test(block)
    ? block.replace(new RegExp(`^(  ${key}:).*$`, 'm'), `$1 ${value}`)
    : block.replace(new RegExp(`^${service}:$`, 'm'), `${service}:\n  ${key}: ${value}`);
  fs.writeFileSync(file, head + edited + tail);
}

function run(check, dir, helmRenders) {
  // 1. A sync that changes nothing must change nothing.
  const before = {
    values: read(dir, 'deploy/helm/values.yaml'),
    werf: read(dir, 'werf.yaml'),
  };
  let r = runSync(dir);
  check('sync with no edits succeeds', r.status === 0, r.err || r.out);
  check('sync with no edits reports nothing to do', /nothing to do/.test(r.out), r.out);
  check('sync with no edits leaves values.yaml alone', read(dir, 'deploy/helm/values.yaml') === before.values);
  check('sync with no edits leaves werf.yaml alone', read(dir, 'werf.yaml') === before.werf);

  // 2. A changed parameter reaches values.yaml.
  editService(dir, 'api', 'replicas', '3');
  r = runSync(dir);
  check('sync applies a changed replica count', r.status === 0, r.err);
  check('values.yaml carries the new replica count',
    /^api:\n  replicas: 3$/m.test(read(dir, 'deploy/helm/values.yaml')),
    read(dir, 'deploy/helm/values.yaml').split('\n').filter(l => /replicas/.test(l)).join(' | '));

  // 3. A service declared by hand is created from the shared template.
  fs.appendFileSync(path.join(dir, 'flarops.yaml'), `
mailer:
  dockerfile: "mailer/Dockerfile"
  context: "mailer"
  replicas: 2
  ports:
    - 9000
  env:
    QUEUE_NAME: "outbound"
  secretEnvs:
    SMTP_TOKEN: SMTP_TOKEN
  exposedRoutes:
    - "/mail"
`);
  r = runSync(dir);
  check('sync creates a newly declared service', r.status === 0, r.err);
  check('a template is written for it', exists(dir, 'deploy/helm/templates/mailer.yaml'));
  const values = read(dir, 'deploy/helm/values.yaml');
  check('it appears in values.yaml with its declared values',
    /- name: mailer/.test(values) && /QUEUE_NAME: "outbound"/.test(values) && /replicas: 2/.test(values), values.slice(-600));
  check('its defaults fill in what was not declared',
    /healthRoute: null/.test(values.slice(values.indexOf('- name: mailer'))), 'healthRoute missing');
  check('werf.yaml learns to build it', /^image: mailer$/m.test(read(dir, 'werf.yaml')), read(dir, 'werf.yaml'));
  // A key the chart now mounts has to be something CI actually puts in the
  // Secret. CI only passes what the workflows name, so sync must add it there
  // too - otherwise the generated deployment looks complete and every pod
  // needing that key sits in CreateContainerConfigError.
  check('the new secret is reported', /SMTP_TOKEN/.test(r.out + (r.err || '')), r.out);
  for (const wf of ['.github/workflows/deploy.yml', '.github/workflows/pr-capsule.yml']) {
    check(`${wf} now passes it`, read(dir, wf).includes('SECRET_ENV_SMTP_TOKEN'),
      read(dir, wf).split('\n').filter(l => /SECRET_ENV_/.test(l)).join('\n'));
  }
  // Flarops' own key is never declared in flarops.yaml, so a list rebuilt from
  // that file alone would drop it - and the dashboard would stop starting,
  // taking every PR capsule's capacity check with it.
  check('the dashboard key is not dropped',
    read(dir, '.github/workflows/deploy.yml').includes('SECRET_ENV_DASHBOARD_PASSWORD_HASH'));
  // Every secretKeyRef in the rendered chart must have a source, which is the
  // failure this whole mechanism exists to prevent.
  {
    const provided = new Set([...read(dir, '.github/workflows/deploy.yml')
      .matchAll(/SECRET_ENV_([A-Z0-9_]+):/g)].map(m => m[1]));
    for (const key of [...provided]) provided.add(`${key}_URLENCODED`);
    const orphans = new Set();
    const templatesDir = path.join(dir, 'deploy/helm/templates');
    for (const file of fs.readdirSync(templatesDir)) {
      if (!file.endsWith('.yaml')) continue;
      for (const m of fs.readFileSync(path.join(templatesDir, file), 'utf8')
        .matchAll(/secretKeyRef:\s*\n\s*name:[^\n]*\n\s*key:\s*([A-Za-z0-9_]+)/g)) {
        if (!provided.has(m[1])) orphans.add(`${file}: ${m[1]}`);
      }
    }
    check('no secretKeyRef is left without a source after sync', orphans.size === 0, [...orphans].join('\n'));
  }

  // 3b. Storage declared by hand on a service this repository BUILDS. Nothing
  // about being built from source makes a workload stateless, and until this
  // was added only a pulled image could ask for a volume.
  fs.appendFileSync(path.join(dir, 'flarops.yaml'), `
archiver:
  dockerfile: "archiver/Dockerfile"
  context: "archiver"
  replicas: 1
  volumes:
    - name: spool
      path: /var/spool/archiver
      size: 40Gi
`);
  r = runSync(dir);
  check('sync accepts a volume on a built service', r.status === 0, r.err);
  const archiver = read(dir, 'deploy/helm/templates/archiver.yaml');
  check('a claim is written for it', /kind: PersistentVolumeClaim/.test(archiver) && /name: archiver-spool/.test(archiver), archiver.slice(0, 400));
  check('the declared size is used', /storage: "40Gi"/.test(archiver), archiver.slice(0, 600));
  check('it is mounted where declared', /mountPath: \/var\/spool\/archiver/.test(archiver));
  // A pod holding a ReadWriteOnce claim has to be gone before its replacement
  // can bind the same volume, so a rolling update would deadlock.
  check('a volume forces Recreate', /type: Recreate/.test(archiver), archiver.slice(0, 700));

  // A volume missing its path cannot be mounted anywhere, and guessing is
  // worse than saying so.
  const beforeBad = read(dir, 'deploy/helm/values.yaml');
  fs.appendFileSync(path.join(dir, 'flarops.yaml'), `
broken:
  image: "busybox:1"
  volumes:
    - name: nowhere
`);
  r = runSync(dir);
  check('a volume without a path is refused', r.status === 1 && /name and a path/.test(r.err || ''), r.err);
  check('nothing was written on that refusal', read(dir, 'deploy/helm/values.yaml') === beforeBad);
  const cleanup = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), cleanup.slice(0, cleanup.indexOf('\nbroken:\n')) + '\n');

  // 3c. A task, not a service. Declared as an ordinary service with
  // replicas: 1 it would become a Deployment, exit, be restarted, and sit in
  // CrashLoopBackOff forever while redoing its work on every loop.
  fs.appendFileSync(path.join(dir, 'flarops.yaml'), `
topic-setup:
  image: "busybox:1"
  oneShot: true
  command: ["sh", "-c", "echo created"]
  secretEnvs:
    SETUP_TOKEN: SETUP_TOKEN
`);
  r = runSync(dir);
  check('sync accepts a one-shot task', r.status === 0, r.err);
  const job = read(dir, 'deploy/helm/templates/support-topic-setup.yaml');
  check('it is rendered as a Job', /kind: Job/.test(job) && !/kind: Deployment/.test(job), job.slice(0, 300));
  check('it re-runs on every deploy', /helm.sh\/hook": post-install,post-upgrade/.test(job), job.slice(0, 400));
  // A Job's pod template is immutable and the name is fixed, so the previous
  // one has to go before the next can be created.
  check('the previous run is removed first', /hook-delete-policy": before-hook-creation/.test(job));
  check('it does not restart on success', /restartPolicy: OnFailure/.test(job));
  check('a task gets no Service', !/kind: Service/.test(job), job.slice(0, 300));

  // A task has no Service, so there is nothing an Ingress rule could point at.
  const beforeRoute = read(dir, 'deploy/helm/values.yaml');
  const withTask = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), withTask + '  exposedRoutes:\n    - "/setup"\n');
  r = runSync(dir);
  check('a one-shot cannot own routes', r.status === 1 && /oneShot/.test(r.err || ''), r.err);
  check('nothing was written on that refusal', read(dir, 'deploy/helm/values.yaml') === beforeRoute);
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), withTask);
  runSync(dir);

  // 3d. A route whose prefix is stripped before the service sees it. Without
  // this the generated Ingress passed /api/... through untouched, the backend
  // answered 404, and the catch-all "/" rule handed the browser HTML where it
  // expected JSON.
  editService(dir, 'api', 'healthRoute', '/health');
  {
    const file = path.join(dir, 'flarops.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const marker = '\n  exposedRoutes:\n';
    const at = text.indexOf(marker);
    check('the api block has exposedRoutes to edit', at !== -1);
    if (at !== -1) {
      const head = text.slice(0, at + marker.length);
      const rest = text.slice(at + marker.length);
      const endRel = rest.search(/\n(?! *- |    )/);
      const tail = endRel === -1 ? '' : rest.slice(endRel);
      fs.writeFileSync(file, `${head}    - path: "/api"\n      stripPrefix: true\n    - "/click"${tail}`);
    }
  }
  r = runSync(dir);
  check('sync accepts a stripped route', r.status === 0, r.err);
  const ingress = read(dir, 'deploy/helm/templates/01-ingress.yaml');
  check('a Middleware is generated for it', /kind: Middleware/.test(ingress) && /- \/api$/m.test(ingress), ingress.slice(-900));
  // Traefik applies a middleware to a whole Ingress, so the stripped route
  // cannot share the main one.
  check('it gets an Ingress of its own', (ingress.match(/kind: Ingress/g) || []).length >= 2);
  check('the middleware is referenced by annotation',
    /traefik\.ingress\.kubernetes\.io\/router\.middlewares/.test(ingress), ingress.slice(-900));
  check('the untransformed route stays on the main Ingress',
    /- path: \{\{ \$route\.path \}\}/.test(ingress), ingress.slice(0, 500));

  // 4. The chart still renders with the hand-written service in it.
  if (helmRenders) {
    const err = helmRenders(dir);
    check('the chart renders and still matches flarops.yaml after sync', !err, err);
  }

  // 5. Removing a service removes its template.
  const text = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), text.slice(0, text.indexOf('\nmailer:\n')) + '\n');
  r = runSync(dir);
  check('sync removes an undeclared service', r.status === 0, r.err);
  check('its template is deleted', !exists(dir, 'deploy/helm/templates/mailer.yaml'));
  check('and CI stops being asked for its secret',
    !read(dir, '.github/workflows/deploy.yml').includes('SECRET_ENV_SMTP_TOKEN'),
    read(dir, '.github/workflows/deploy.yml').split('\n').filter(l => /SECRET_ENV_/.test(l)).join('\n'));

  // 6. Unreadable input is refused with a line number, and nothing is written.
  const good = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  const valuesBefore = read(dir, 'deploy/helm/values.yaml');
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), good.replace(/^api:$/m, 'api:\n  replicas: 1\n  replicas: 2'));
  r = runSync(dir);
  check('a duplicate key is refused', r.status === 1, r.out);
  check('the refusal names the line', /line \d+/.test(r.err || ''), r.err);
  check('nothing was written on refusal', read(dir, 'deploy/helm/values.yaml') === valuesBefore);
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), good);

  // 7. An empty file is a truncation, not a request to delete everything.
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), '# nothing here\n');
  r = runSync(dir);
  check('an empty flarops.yaml is refused', r.status === 1 && /no services/i.test(r.err || ''), r.err);
  check('the deployment survives it', read(dir, 'deploy/helm/values.yaml') === valuesBefore);
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), good);

  // 8. Without the recorded state there is nothing to merge into.
  const statePath = path.join(dir, 'deploy', '.flarops-state.json');
  const state = fs.readFileSync(statePath);
  fs.unlinkSync(statePath);
  r = runSync(dir);
  check('sync refuses without the recorded state', r.status === 1 && /state/i.test(r.err || ''), r.err);
  fs.writeFileSync(statePath, state);
}

module.exports = { run };
