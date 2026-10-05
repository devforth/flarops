// End-to-end checks for `flarops sync` against a generated project.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'index.js');

// spawnSync: stderr is needed even when the exit code is 0.
function runSync(dir) {
  const r = spawnSync('node', [CLI, 'sync'], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

function editService(dir, service, key, value) {
  const file = path.join(dir, 'flarops.yaml');
  const text = fs.readFileSync(file, 'utf8');
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
  check('the new secret is reported', /SMTP_TOKEN/.test(r.out + (r.err || '')), r.out);
  for (const wf of ['.github/workflows/deploy.yml', '.github/workflows/pr-capsule.yml']) {
    check(`${wf} now passes it`, read(dir, wf).includes('SECRET_ENV_SMTP_TOKEN'),
      read(dir, wf).split('\n').filter(l => /SECRET_ENV_/.test(l)).join('\n'));
  }
  check('the dashboard key is not dropped',
    read(dir, '.github/workflows/deploy.yml').includes('SECRET_ENV_DASHBOARD_PASSWORD_HASH'));
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

  // 3b. Storage on a service this repository builds.
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
  check('a volume forces Recreate', /type: Recreate/.test(archiver), archiver.slice(0, 700));

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

  // 3a'. Repository settings: where the images are pushed.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    check('flarops.yaml starts with the repository settings', /^# repository settings\nrepositorySettings:\n/.test(original), original.slice(0, 200));
    const harbor = original
      .replace(/^  registry: .*$/m, '  registry: harbor.example.com')
      .replace(/^  project: .*$/m, '  project: team')
      .replace(/^  repository: .*$/m, '  repository: shop-web');
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), harbor);
    r = runSync(dir);
    check('sync applies new repository settings', r.status === 0 && /repositorySettings\.project: none -> team/.test(r.out), r.err || r.out);
    for (const wf of ['.github/workflows/deploy.yml', '.github/workflows/pr-capsule.yml']) {
      const text = read(dir, wf);
      check(`${wf} pushes to <registry>/<project>/<repository>`, text.includes('--repo harbor.example.com/team/shop-web'), text.match(/--repo .*/) && text.match(/--repo .*/)[0]);
      check(`${wf} logs in to the registry host`, /registry: harbor\.example\.com\n/.test(text));
    }
    r = runSync(dir);
    check('unchanged repository settings report nothing', /nothing to do/.test(r.out), r.out);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), harbor.replace(/^  registry: .*$/m, '  registry: harbor.example.com/team'));
    r = runSync(dir);
    check('a registry with a path is refused', r.status === 1 && /repositorySettings\.registry/.test(r.err || ''), r.err);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), harbor.replace(/^  project: .*$/m, '  project: Team Space'));
    r = runSync(dir);
    check('an invalid project is refused', r.status === 1 && /repositorySettings\.project/.test(r.err || ''), r.err);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('restoring the defaults goes back to Docker Hub', r.status === 0 && read(dir, '.github/workflows/deploy.yml').includes('--repo docker.io/${{ env.REGISTRY_USER }}/'), r.err || r.out);
  }

  // 3a''. Database server settings: command: becomes the database container's args.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    const withCommand = original.replace(/^(database:\n(?:  .*\n)*?  type: .*\n)/m,
      '$1  command:\n    - postgres\n    - -c\n    - wal_level=logical\n');
    check('the database block has a type line to extend', withCommand !== original);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), withCommand);
    r = runSync(dir);
    check('sync applies a database command', r.status === 0 && /database\.command/.test(r.out), r.err || r.out);
    check('values.yaml carries it for the database',
      /^database:\n(?:  .*\n)*?  command:\n    - "postgres"\n    - "-c"\n    - "wal_level=logical"$/m.test(read(dir, 'deploy/helm/values.yaml')),
      read(dir, 'deploy/helm/values.yaml').match(/^database:\n(?:  .*\n)*/m));
    if (helmRenders) {
      const err = helmRenders(dir);
      check('the chart renders the database command as args', !err, err);
    }
    r = runSync(dir);
    check('an unchanged database command reports nothing', /nothing to do/.test(r.out), r.out);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('removing the database command takes it out of values.yaml',
      r.status === 0 && !/^database:\n(?:  .*\n)*?  command:/m.test(read(dir, 'deploy/helm/values.yaml')), r.err || r.out);
  }

  // 3a'''. databaseUrls: URLs the chart builds from the database, for any service built here.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    const reporter = `
reporter:
  dockerfile: "reporter/Dockerfile"
  context: "reporter"
  replicas: 1
  ports:
    - 8080
  databaseUrls:
    - DATABASE_URL
`;
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original + reporter);
    r = runSync(dir);
    check('sync accepts databaseUrls on a declared service', r.status === 0 && /reporter\.databaseUrls/.test(r.out), r.err || r.out);
    const template = read(dir, 'deploy/helm/templates/reporter.yaml');
    check('the chart builds its URL against the top-level database',
      /- name: DATABASE_URL\n\s+value: "postgres(ql)?:\/\/[^:]+:\$\(POSTGRES_PASSWORD_URLENCODED\)@database:5432\/[^"]+"/.test(template),
      (template.match(/- name: DATABASE_URL[\s\S]{0,160}/) || [template.slice(0, 300)])[0]);
    check('no GitHub Secret is asked for the URL', !read(dir, '.github/workflows/deploy.yml').includes('SECRET_ENV_DATABASE_URL'));
    if (helmRenders) {
      const err = helmRenders(dir);
      check('the chart renders with databaseUrls and matches flarops.yaml', !err, err);
    }
    r = runSync(dir);
    check('unchanged databaseUrls report nothing', /nothing to do/.test(r.out), r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original + reporter + '  secretEnvs:\n    DATABASE_URL: DATABASE_URL\n');
    r = runSync(dir);
    check('a name in both databaseUrls and secretEnvs is refused', r.status === 1 && /reporter\.databaseUrls/.test(r.err || ''), r.err || r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original.replace(/^frontend:\n/m, 'frontend:\n  databaseUrls:\n    - DATABASE_URL\n') + reporter);
    r = runSync(dir);
    check('databaseUrls on the frontend is refused', r.status === 1 && /frontend\.databaseUrls/.test(r.err || ''), r.err || r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original + reporter.replace(/  databaseUrls:\n    - DATABASE_URL\n/, ''));
    r = runSync(dir);
    check('removing databaseUrls stops the URL', r.status === 0 && !/name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/reporter.yaml')), r.err || r.out);

    // State from before the field: what init built stays until flarops.yaml names it.
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original.replace(/^api:\n/m, 'api:\n  databaseUrls:\n    - DATABASE_URL\n'));
    r = runSync(dir);
    check('databaseUrls on api builds its URL', r.status === 0 && /- name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.err || r.out);
    const statePath = path.join(dir, 'deploy/.flarops-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete state.databaseUrlsDeclared;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('older state keeps the URLs init built when flarops.yaml does not name them',
      /nothing to do/.test(r.out) && /- name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.err || r.out);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original.replace(/^api:\n/m, 'api:\n  databaseUrls: []\n'));
    r = runSync(dir);
    check('databaseUrls: [] removes them there', r.status === 0 && !/- name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.err || r.out);
    state.databaseUrlsDeclared = true;
    state.dbUrlVars = [];
    fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, 'utf8')), databaseUrlsDeclared: true }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('back to the original flarops.yaml', r.status === 0, r.err || r.out);
  }

  // 3b'. Values pasted unescaped into file names and workflows must be refused.
  const hostile = [
    ['a service name outside the chart', '"../../../.github/workflows/pwn":\n  image: "busybox:1"\n', /not a valid service name/],
    ['a secret key that adds workflow lines', 'hostile:\n  image: "busybox:1"\n  secretEnvs:\n    X: "X }}\\n      INJECTED: ${{ github.token"\n', /not a valid GitHub secret name/],
    ['a build context outside the repository', 'hostile:\n  dockerfile: Dockerfile\n  context: ../../elsewhere\n', /inside the repository/],
    ['a port out of range', 'hostile:\n  image: "busybox:1"\n  ports:\n    - 99999\n', /port number/],
  ];
  const cleanFile = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  const cleanWorkflow = read(dir, '.github/workflows/deploy.yml');
  for (const [label, block, message] of hostile) {
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), cleanFile + '\n' + block);
    r = runSync(dir);
    check(`${label} is refused`, r.status === 1 && message.test(r.err || ''), r.err || r.out);
  }
  check('nothing reached .github/workflows on those refusals',
    !exists(dir, '.github/workflows/pwn.yaml') && read(dir, '.github/workflows/deploy.yml') === cleanWorkflow);
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), cleanFile);

  // 3c. A one-shot task.
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
  check('the previous run is removed first', /hook-delete-policy": before-hook-creation/.test(job));
  check('it does not restart on success', /restartPolicy: OnFailure/.test(job));
  check('a task gets no Service', !/kind: Service/.test(job), job.slice(0, 300));

  const beforeRoute = read(dir, 'deploy/helm/values.yaml');
  const withTask = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), withTask + '  exposedRoutes:\n    - "/setup"\n');
  r = runSync(dir);
  check('a one-shot cannot own routes', r.status === 1 && /oneShot/.test(r.err || ''), r.err);
  check('nothing was written on that refusal', read(dir, 'deploy/helm/values.yaml') === beforeRoute);
  fs.writeFileSync(path.join(dir, 'flarops.yaml'), withTask);
  runSync(dir);

  // 3d. A route whose prefix is stripped.
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
  check('it gets an Ingress of its own', (ingress.match(/kind: Ingress/g) || []).length >= 2);
  check('the middleware is referenced by annotation',
    /traefik\.ingress\.kubernetes\.io\/router\.middlewares/.test(ingress), ingress.slice(-900));
  check('the untransformed route stays on the main Ingress',
    /- path: \{\{ \$route\.path \}\}/.test(ingress), ingress.slice(0, 500));

  // 3e. Stripped routes whose slugs collide.
  {
    const file = path.join(dir, 'flarops.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const marker = '\n  exposedRoutes:\n';
    const at = text.indexOf(marker);
    if (at !== -1) {
      const head = text.slice(0, at + marker.length);
      const rest = text.slice(at + marker.length);
      const endRel = rest.search(/\n(?! *- |    )/);
      const tail = endRel === -1 ? '' : rest.slice(endRel);
      fs.writeFileSync(file, `${head}    - path: "/a/b"\n      stripPrefix: true\n    - path: "/a-b"\n      stripPrefix: true${tail}`);
    }
  }
  r = runSync(dir);
  check('sync accepts two colliding route slugs', r.status === 0, r.err);
  {
    const text = read(dir, 'deploy/helm/templates/01-ingress.yaml');
    const objectNames = [...text.matchAll(/^  name: (\S+)$/gm)].map(m => m[1]);
    check('colliding routes get distinct object names',
      objectNames.length === new Set(objectNames).size, objectNames.join(', '));
    check('a colliding name carries a hash of its own path',
      objectNames.filter(n => /-strip-a-b-[0-9a-f]{6}(-ingress)?$/.test(n)).length === 4,
      objectNames.join(', '));
    for (const m of text.matchAll(/router\.middlewares: "\{\{ \.Release\.Namespace \}\}-([^@]+)@/g)) {
      check(`middleware ${m[1]} is defined`, objectNames.includes(m[1]), objectNames.join(', '));
    }
  }
  {
    const file = path.join(dir, 'flarops.yaml');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text
      .replace('    - path: "/a/b"\n      stripPrefix: true\n', '    - path: "/api"\n      stripPrefix: true\n')
      .replace('    - path: "/a-b"\n      stripPrefix: true', '    - "/click"'));
    runSync(dir);
  }

  // 3f. Secrets under "database".
  {
    const file = path.join(dir, 'flarops.yaml');
    const good = fs.readFileSync(file, 'utf8');
    const at = good.indexOf('\ndatabase:\n');
    check('the fixture has a database block', at !== -1);
    if (at !== -1) {
      const marker = '  secretEnvs:\n';
      const secretsAt = good.indexOf(marker, at);
      check('the database block declares a secret', secretsAt !== -1);
      if (secretsAt !== -1) {
        const insertAt = good.indexOf('\n', secretsAt + marker.length) + 1;

        fs.writeFileSync(file, good.slice(0, insertAt) + '    JWT_SECRET: JWT_SECRET\n' + good.slice(insertAt));
        r = runSync(dir);
        check('a misplaced secret does not stop the sync', r.status === 0, r.err);
        check('it is reported as reaching no container',
          /no workload reads them/.test(r.err || '') && /JWT_SECRET/.test(r.err || ''), r.err);

        fs.writeFileSync(file, good);
        runSync(dir);
        const firstKey = (good.slice(secretsAt, insertAt).match(/:\s*(\S+)\s*$/m) || [])[1];
        if (firstKey) {
          fs.writeFileSync(file, good.slice(0, insertAt) + `    SECOND_NAME: ${firstKey}\n` + good.slice(insertAt));
          r = runSync(dir);
          check('a second NAME for the same key is accepted', r.status === 0, r.err);
          check('and is not reported as unread',
            !/no workload reads them/.test(r.err || ''), r.err);
        }
      }
    }
    fs.writeFileSync(file, good);
    runSync(dir);
  }

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
