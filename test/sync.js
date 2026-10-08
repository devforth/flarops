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
  dockerfile: "Dockerfile"
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
  dockerfile: "Dockerfile"
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
  check('it is mounted where declared', /mountPath: \{\{ "\/var\/spool\/archiver" \| quote \}\}/.test(archiver), archiver.slice(0, 900));
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
  dockerfile: "Dockerfile"
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

    // On api, and taken away again by leaving the field out.
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original.replace(/^api:\n/m, 'api:\n  databaseUrls:\n    - DATABASE_URL\n'));
    r = runSync(dir);
    check('databaseUrls on api builds its URL', r.status === 0 && /- name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.err || r.out);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('leaving databaseUrls out of api removes its URL', r.status === 0 && !/- name: DATABASE_URL/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.err || r.out);
  }

  // 3a''''. syncLock: files sync leaves as they are.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    check('init writes an empty syncLock', /^syncLock: \{\}$/m.test(original));
    const withLock = (entries) => original.replace(/^syncLock: \{\}$/m, 'syncLock:\n' + entries.map(e => '  ' + e).join('\n'));
    const apiFile = path.join(dir, 'deploy/helm/templates/api.yaml');
    const handEdited = read(dir, 'deploy/helm/templates/api.yaml') + '# changed by hand\n';
    fs.writeFileSync(apiFile, handEdited);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), withLock(['deploy/helm/templates/api.yaml: true']));
    editService(dir, 'api', 'replicas', '4');
    r = runSync(dir);
    check('sync applies changes with a template locked', r.status === 0 && /api\.replicas/.test(r.out), r.err || r.out);
    check('the locked template is left as it is', read(dir, 'deploy/helm/templates/api.yaml') === handEdited);
    check('the rest still follows flarops.yaml', /^api:\n  replicas: 4$/m.test(read(dir, 'deploy/helm/values.yaml')));
    check('a change that does not touch the locked file is not reported against it', !/syncLock kept/.test(r.err), r.err);

    // A renamed secret is written into api.yaml itself.
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), read(dir, 'flarops.yaml')
      .replace('    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n', '    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n    LOG_TOKEN: LOG_SINK_TOKEN\n'));
    r = runSync(dir);
    check('the locked template is still left as it is', read(dir, 'deploy/helm/templates/api.yaml') === handEdited);
    const lastLine = (r.out + r.err).trim().split('\n').pop();
    check('a change that would reach the locked file is the last thing sync says', /syncLock kept these files.*deploy\/helm\/templates\/api\.yaml/.test(lastLine), lastLine);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), withLock(['deploy/helm/templates/api.yaml: false']));
    editService(dir, 'api', 'replicas', '2');
    r = runSync(dir);
    check('false unlocks it', r.status === 0 && read(dir, 'deploy/helm/templates/api.yaml') !== handEdited && !/syncLock kept/.test(r.err), r.err || r.out);

    const before = read(dir, 'deploy/helm/values.yaml');
    for (const [entry, label, message] of [
      ['deploy/helm/values.yaml: true', 'values.yaml', /cannot be locked/],
      ['werf.yaml: true', 'werf.yaml', /cannot be locked/],
      ['deploy/.flarops-state.json: true', 'the state file', /cannot be locked/],
      ['deploy/helm/templates/apii.yaml: true', 'a file sync does not write', /not a file sync writes/],
      ['../outside.yaml: true', 'a path outside the project', /relative to the project root/],
      ['deploy/helm/templates/api.yaml: yes', 'a value other than true or false', /true or false/],
    ]) {
      fs.writeFileSync(path.join(dir, 'flarops.yaml'), withLock([entry]));
      editService(dir, 'api', 'replicas', '3');
      r = runSync(dir);
      check(`locking ${label} is refused`, r.status === 1 && message.test(r.err), r.err || r.out);
    }
    check('nothing was written on those refusals', read(dir, 'deploy/helm/values.yaml') === before);

    // A locked template of a removed service.
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), withLock(['.github/workflows/deploy.yml: true']) + `
pinger:
  dockerfile: "Dockerfile"
  context: "pinger"
  replicas: 1
  ports:
    - 8080
  secretEnvs:
    PINGER_TOKEN: PINGER_TOKEN
`);
    r = runSync(dir);
    check('a workflow can be locked', r.status === 0 && /syncLock kept these files.*deploy\.yml/.test(r.err)
      && !read(dir, '.github/workflows/deploy.yml').includes('SECRET_ENV_PINGER_TOKEN'), r.err || r.out);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), withLock(['deploy/helm/templates/pinger.yaml: true']));
    r = runSync(dir);
    check('removing a service whose template is locked is refused', r.status === 1 && /no longer declares/.test(r.err), r.err || r.out);
    check('its template is still there', exists(dir, 'deploy/helm/templates/pinger.yaml'));

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('without the lock the service is removed again', r.status === 0 && !exists(dir, 'deploy/helm/templates/pinger.yaml'), r.err || r.out);
  }

  // 3c. What flarops.yaml may say: refusals that name the field, nothing written.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    const valuesBefore = read(dir, 'deploy/helm/values.yaml');
    const append = (block) => original + block;
    const refused = [
      ['a misspelled field', original.replace(/^(api:\n)/m, '$1  replcas: 3\n'), /api\.replcas" is not a field/],
      ['an unknown key in db:', append('\nworker:\n  dockerfile: Dockerfile\n  context: worker\n  db:\n    type: postgres\n    secretEnvs:\n      POSTGRES_PASSWORD: W_PW\n    passwordKey: "W_PW"\n'), /worker\.db\.passwordKey" is not a field/],
      ['a db: without its password', append('\nworker:\n  dockerfile: Dockerfile\n  context: worker\n  db:\n    type: postgres\n'), /worker\.db\.secretEnvs" is required/],
      ['redis as a database', append('\nworker:\n  dockerfile: Dockerfile\n  context: worker\n  db:\n    type: redis\n    secretEnvs:\n      REDIS_PASSWORD: W_PW\n'), /worker\.db\.type" must be one of/],
      ['two replicas of a database', original.replace(/^(database:\n(?:  .*\n)*?)  replicas: 1\n/m, '$1  replicas: 2\n'), /database\.replicas" must be 0 or 1/],
      ['the deploy pipeline\'s own credential', original.replace('    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n', '    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n    LOG_KEY: AWS_SECRET_ACCESS_KEY\n'), /deploy pipeline's own credentials/],
      ['braces in a route', original.replace(/^    - \/api$/m, '    - path: /x{{.Values.database.password}}\n      stripPrefix: true'), /without spaces, quotes, backslashes or braces/],
      ['a service named like a chart file', append('\nsecret:\n  image: "nginx:1"\n  replicas: 1\n'), /"secret" is a name Flarops or YAML already uses/],
      ['a service name starting with a digit', append('\n9worker:\n  image: "nginx:1"\n  replicas: 1\n'), /not a valid service name/],
      ['a service named after another\'s database', append('\nworker:\n  dockerfile: Dockerfile\n  context: worker\n  db:\n    type: postgres\n    secretEnvs:\n      POSTGRES_PASSWORD: W_PW\nworker-db:\n  image: "nginx:1"\n'), /is the name of worker's own database/],
      ['one name in env and secretEnvs', original.replace('    DB_HOST: database\n', '    DB_HOST: database\n    POSTGRES_PASSWORD: plain\n'), /api\.env\.POSTGRES_PASSWORD" is also under secretEnvs/],
      ['a support service without an image', append('\ncache:\n  replicas: 1\n'), /needs either image/],
      ['a pipeline credential in lower case', original.replace('    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n', '    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n    LOG_KEY: aws_secret_access_key\n'), /deploy pipeline's own credentials/],
      ['a GITHUB_ secret', original.replace('    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n', '    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n    GH: GITHUB_TOKEN\n'), /deploy pipeline's own credentials/],
      ['a secret with no name', original.replace('    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n', '    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n    TOKEN:\n'), /needs the name of the GitHub secret/],
      ['a command that is a map', original.replace(/^(api:\n)/m, '$1  command: {a: 1}\n'), /api\.command" must be a list of arguments/],
      ['a build arg without "="', original.replace(/^(api:\n)/m, '$1  buildArgs:\n    - NOEQUALS\n'), /not written as KEY=value/],
      ['a YAML tag', original.replace(/^(api:\n)/m, '$1  replicas: !!int 3\n').replace(/^  replicas: 1\n(?=  ports:\n    - 4000)/m, ''), /tags such as/],
    ];
    for (const [label, text, message] of refused) {
      fs.writeFileSync(path.join(dir, 'flarops.yaml'), text);
      r = runSync(dir);
      check(`refuses ${label}`, r.status === 1 && message.test(r.err), r.err || r.out);
    }
    check('nothing was written on those refusals', read(dir, 'deploy/helm/values.yaml') === valuesBefore);
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('back to the original after the refusals', r.status === 0, r.err || r.out);
  }

  // 3d. A service's own database: defaults, switching to and from the shared one, renames.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    const shared = original + '\nworker:\n  dockerfile: Dockerfile\n  context: worker\n  replicas: 1\n  ports: []\n  databaseUrls:\n    - DATABASE_URL\n';
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), shared);
    r = runSync(dir);
    check('a service on the top-level database syncs', r.status === 0, r.err || r.out);
    check('its URL points at the top-level database', /@database:5432\//.test(read(dir, 'deploy/helm/templates/worker.yaml')));

    const own = shared + '  db:\n    type: PostgreSQL\n    secretEnvs:\n      POSTGRES_PASSWORD: WORKER_DB_PASSWORD\n';
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), own);
    r = runSync(dir);
    check('adding db: gives it a database of its own', r.status === 0 && exists(dir, 'deploy/helm/templates/worker-db.yaml'), r.err || r.out);
    const values = read(dir, 'deploy/helm/values.yaml');
    check('the engine fills in what db: leaves out', /    db:\n      type: "postgresql"\n      image: "postgres:18-alpine"\n      port: 5432\n      user: "postgres"\n      name: "workerdb"/.test(values), values.match(/    db:\n(?:      .*\n)*/) && values.match(/    db:\n(?:      .*\n)*/)[0]);
    check('nothing renders as undefined', !/undefined/.test(values + read(dir, 'deploy/helm/templates/worker-db.yaml') + read(dir, 'deploy/helm/templates/worker.yaml')));
    check('the URL now points at its own database', /@worker-db:5432\/workerdb"/.test(read(dir, 'deploy/helm/templates/worker.yaml')), read(dir, 'deploy/helm/templates/worker.yaml').match(/DATABASE_URL[\s\S]{0,160}/));
    r = runSync(dir);
    check('that settles: the next sync has nothing to do', /nothing to do/.test(r.out), r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), own.replace('    secretEnvs:\n      POSTGRES_PASSWORD: WORKER_DB_PASSWORD\n', '    name: jobs\n    secretEnvs:\n      POSTGRES_PASSWORD: WORKER_DB_PASSWORD\n'));
    r = runSync(dir);
    check('renaming its database moves the URL with it', r.status === 0 && /@worker-db:5432\/jobs"/.test(read(dir, 'deploy/helm/templates/worker.yaml')), r.err || r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), shared);
    r = runSync(dir);
    check('removing db: removes its database', r.status === 0 && !exists(dir, 'deploy/helm/templates/worker-db.yaml'), r.err || r.out);
    check('and says the data volume stays', /PVC data-worker-db-0/.test(r.err), r.err);
    check('the URL is back on the top-level database', /@database:5432\//.test(read(dir, 'deploy/helm/templates/worker.yaml')));

    // The top-level database: block may come after the services that use it.
    const reordered = shared.replace(/^database:\n(?:  .*\n|    .*\n)*/m, '') + '\n' + original.match(/^database:\n(?:  .*\n)*/m)[0].replace(/  port: 5432\n/, '  port: 5433\n');
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), reordered);
    r = runSync(dir);
    check('a database declared below its users applies in one sync', r.status === 0 && /@database:5433\//.test(read(dir, 'deploy/helm/templates/worker.yaml')), r.err || r.out);
    r = runSync(dir);
    check('and the next sync has nothing to do', /nothing to do/.test(r.out), r.out);
    const svc = read(dir, 'deploy/helm/templates/database.yaml');
    check('the database port moves the Service, not the server', /port: \{\{ \.Values\.dbPort \| default 5433 \}\}\n      targetPort: 5432/.test(svc), svc.slice(0, 500));

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), reordered.replace(/^database:\n(?:  .*\n)*/m, '').replace(/^(api:\n(?:  .*\n|    .*\n)*?)  secretEnvs:\n    POSTGRES_PASSWORD: POSTGRES_PASSWORD\n/m, '$1'));
    r = runSync(dir);
    check('removing the database while a service uses it is refused', r.status === 1 && /worker\.databaseUrls" needs a database/.test(r.err), r.err || r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('back to the original after the database changes', r.status === 0, r.err || r.out);
  }

  // 3e. Files sync did not generate, files that drifted, and what the values may say.
  {
    const original = fs.readFileSync(path.join(dir, 'flarops.yaml'), 'utf8');
    fs.writeFileSync(path.join(dir, 'deploy/helm/templates/extra-config.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\n');
    editService(dir, 'api', 'replicas', '0');
    r = runSync(dir);
    check('a template added by hand is left alone', r.status === 0 && exists(dir, 'deploy/helm/templates/extra-config.yaml') && !/extra-config/.test(r.out), r.out);
    check('replicas: 0 scales to 0', /^api:\n  replicas: 0$/m.test(read(dir, 'deploy/helm/values.yaml')));
    r = runSync(dir);
    check('and stays there', /nothing to do/.test(r.out), r.out);
    fs.unlinkSync(path.join(dir, 'deploy/helm/templates/extra-config.yaml'));

    const apiFile = path.join(dir, 'deploy/helm/templates/api.yaml');
    fs.writeFileSync(apiFile, read(dir, 'deploy/helm/templates/api.yaml') + '# drifted\n');
    r = runSync(dir);
    check('a generated file that drifted is rewritten even with flarops.yaml unchanged', r.status === 0 && /rewritten from this version/.test(r.out) && !/# drifted/.test(read(dir, 'deploy/helm/templates/api.yaml')), r.out);

    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original
      .replace(/^(api:\n)/m, '$1  command: ["node", "server.js", "--greeting={{ hello }}"]\n')
      + '\nmigrate:\n  dockerfile: Dockerfile\n  context: migrate\n  oneShot: true\n  ports: []\n  databaseUrls:\n    - DATABASE_URL\n');
    r = runSync(dir);
    check('a one-shot task with databaseUrls syncs', r.status === 0, r.err || r.out);
    check('the task gets its URL', /- name: DATABASE_URL\n\s+value: "postgres(ql)?:\/\/[^"]*@database:/.test(read(dir, 'deploy/helm/templates/migrate.yaml')), read(dir, 'deploy/helm/templates/migrate.yaml'));
    if (helmRenders) {
      const err = helmRenders(dir);
      check('"{{" in an api argument stays text', !err, err);
    }
    fs.writeFileSync(path.join(dir, 'flarops.yaml'), original);
    r = runSync(dir);
    check('back to the original after the file checks', r.status === 0, r.err || r.out);
  }

  // 3f. The Flarops section of AGENTS.md is kept current; the rest of the file is left alone.
  {
    const agentsFile = path.join(dir, 'AGENTS.md');
    check('init writes the Flarops section of AGENTS.md', exists(dir, 'AGENTS.md') && /<!-- flarops:begin[\s\S]*flarops\.yaml[\s\S]*<!-- flarops:end -->/.test(read(dir, 'AGENTS.md')));
    check('CLAUDE.md imports it', exists(dir, 'CLAUDE.md') && /^@AGENTS\.md$/m.test(read(dir, 'CLAUDE.md')));
    const original = read(dir, 'AGENTS.md');
    fs.writeFileSync(agentsFile, '# Our notes\n\n' + original.replace('## Deployment (Flarops)', '## Deployment (edited)') + '\nMore notes.\n');
    r = runSync(dir);
    const after = read(dir, 'AGENTS.md');
    check('sync restores an edited Flarops section', r.status === 0 && after.includes('## Deployment (Flarops)') && !after.includes('(edited)'), r.err || r.out);
    check('and keeps what is outside it', after.startsWith('# Our notes\n') && after.endsWith('More notes.\n'), after.slice(0, 200));
    r = runSync(dir);
    check('a current section is nothing to do', /nothing to do/.test(r.out), r.out);
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
  check('a Middleware is generated for it', /kind: Middleware/.test(ingress) && /- \{\{ "\/api" \| quote \}\}$/m.test(ingress), ingress.slice(-900));
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
