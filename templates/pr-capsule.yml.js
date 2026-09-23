module.exports = function prCapsuleYmlTemplate(config) {
  const repoString = config.dockerRegistry
    ? `\${{ env.DOCKER_REGISTRY }}/\${{ env.PROJECT_NAME }}`
    : `docker.io/\${{ env.REGISTRY_USER }}/\${{ env.PROJECT_NAME }}`;

  const registryEnv = config.dockerRegistry
    ? 'DOCKER_REGISTRY: ' + config.dockerRegistry
    : '';

  const loginRegistryHost = config.dockerRegistry
    ? config.dockerRegistry.split('/')[0]
    : 'docker.io';

  const loginStep = `
      - name: Login to Docker Registry
        uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3
        with:
          registry: ${loginRegistryHost}
          username: \${{ env.REGISTRY_USER }}
          password: \${{ secrets.REGISTRY_PASSWORD }}`;

  // See templates/deploy.yml.js for why secrets are passed via a step-level `env:`
  // block and serialized into a values file, instead of `--set env.K=${{ secrets.K }}`
  // inline in a `run:` shell string.
  const secretEnvBlock = config.envKeysToPass && config.envKeysToPass.length > 0
    ? config.envKeysToPass.map(k => `          SECRET_ENV_${k}: \${{ secrets.${k} }}`).join('\n') + '\n'
    : '';

  // Registry credentials travel the same way every other secret does: through
  // the CI-written values file, never through anything committed to git. They
  // become the chart's imagePullSecret so private images can actually be
  // pulled by the cluster.
  // The registry host as Docker itself keys it in config.json - Docker Hub
  // uses this legacy URL rather than "docker.io".
  const registryServerForPull = config.dockerRegistry ? config.dockerRegistry.split('/')[0] : 'https://index.docker.io/v1/';

  // The instance shape is carried from Terraform's own outputs rather than
  // duplicated in values.yaml, so variables.tf stays the one place an operator
  // edits to change what the fleet runs on.
  //
  // A key is OMITTED rather than written as null when its value is unknown.
  // Helm does not treat a null in an override file as "no opinion" - it
  // DELETES the key, so writing "aws": null removed the chart's entire aws
  // block and the dashboard's own "{{ .Values.aws.region }}" then aborted the
  // rendering of every object in the chart. That is not a rare path: the
  // Terraform outputs read above do not exist in a state file written before
  // they were added, and the PR-capsule job does not necessarily run an apply
  // at all, so the first deploy after an upgrade hit it every time.
  const buildValuesScript = `python3 -c "import json,os; data={'env': {k[len('SECRET_ENV_'):]: v for k,v in os.environ.items() if k.startswith('SECRET_ENV_')}, 'database': {'password': os.environ.get('SECRET_DB_PASSWORD','')}}; reg=os.environ.get('SECRET_REGISTRY_PASSWORD',''); data.update({'imagePullSecret': {'server': os.environ.get('REGISTRY_SERVER',''), 'username': os.environ.get('REGISTRY_USER',''), 'password': reg}} if reg else {}); aws={k:v for k,v in (('instanceType',os.environ.get('TF_INSTANCE_TYPE','')),('volumeSize',os.environ.get('TF_VOLUME_SIZE',''))) if v}; data.update({'aws': aws} if aws else {}); open('deploy/helm/flarops-ci-values.json','w').write(json.dumps(data))"`;

  // See templates/deploy.yml.js for why this is gated on hasDbPassword instead
  // of always referencing a "DATABASE_PASSWORD" secret that may not exist.
  const dbPasswordEnvLine = config.hasDbPassword ? `          SECRET_DB_PASSWORD: \${{ secrets.${config.dbPasswordKey} }}\n` : '';

  let dbDumpCmd = '';

  // The password is NEVER interpolated into these shell strings. Expanding
  // "${{ secrets.X }}" inside a `run:` block puts the literal secret into a
  // command line the runner's shell then parses, so a password containing a
  // backtick or $( ) executes arbitrary code on a runner that is holding AWS
  // keys, the SSH deploy key and a cluster-admin kubeconfig - and the value
  // also shows up in the node's process table.
  //
  // It isn't needed at all: the database container already has its own
  // password in its own environment (see templates/database/deployment.js).
  // Wrapping the command in `sh -c '...'` with SINGLE quotes means the
  // runner's shell passes the string through untouched and the variable is
  // expanded by the shell inside the database pod, from that pod's env.
  const dbPasswordEnvVarInContainer = {
    postgres: 'POSTGRES_PASSWORD',
    postgresql: 'POSTGRES_PASSWORD',
    mysql: 'MYSQL_ROOT_PASSWORD',
    mariadb: 'MARIADB_ROOT_PASSWORD',
    mongodb: 'MONGO_INITDB_ROOT_PASSWORD'
  }[config.dbType];

  // Streamed pod to pod, never through a file on the runner. Writing the dump
  // to disk first put the ENTIRE production database on a shared GitHub
  // runner - slow on anything large, and a copy of live data somewhere it has
  // no business being. A pipe also means "set -o pipefail" catches a failure
  // on either end, which a redirect into a file silently did not.
  //
  // Every value comes from the database pod's own environment. Nothing is
  // interpolated into the shell text, so a password containing a backtick or
  // $( ) cannot execute on the runner.
  // Provider configuration for EVERY step that runs "terraform apply". Kept as
  // one constant because it drifted: the teardown step was rewritten without
  // it, and Terraform then handed the Cloudflare provider an empty api_token -
  // which fails validation, so reclaiming an idle worker aborted and the node
  // kept being billed. A step that only runs init/workspace/output does not
  // configure providers and deliberately does not get these.
  const terraformProviderEnv = `        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
`;

  const mainExec = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 --`;
  const prExec = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 --`;

  if (config.hasDb) {
    if (config.dbType === 'postgres' || config.dbType === 'postgresql') {
      // --clean --if-exists makes a re-clone into a populated database work.
      // ON_ERROR_STOP=1 is what makes psql FAIL on a bad statement: without it
      // psql exits 0 having skipped every failing line, and a broken restore
      // reported success.
      dbDumpCmd = `${mainExec} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \\
            | ${prExec} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`;
    } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      // MariaDB 11 dropped the mysql* binaries entirely and ships only
      // mariadb-dump/mariadb; 10.x ships both; MySQL ships only the mysql*
      // ones. Resolve at runtime rather than guessing from the image tag.
      const passVar = config.dbType === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
      const dbVar = config.dbType === 'mariadb' ? 'MARIADB_DATABASE' : 'MYSQL_DATABASE';
      // MYSQL_PWD keeps the password out of the argument list, so it is not
      // visible in the database pod's process table either. Both clients read it.
      dbDumpCmd = `${mainExec} sh -c 'MYSQL_PWD="$${passVar}" $(command -v mariadb-dump || command -v mysqldump) --single-transaction --routines --triggers -u root "$${dbVar}"' \\
            | ${prExec} sh -c 'MYSQL_PWD="$${passVar}" $(command -v mariadb || command -v mysql) -u root "$${dbVar}"'`;
    } else if (config.dbType === 'mongodb') {
      // --archive with no filename streams to stdout; --quiet keeps progress
      // logging off it. mongodump/mongorestore ship in the official image.
      dbDumpCmd = `${mainExec} sh -c 'mongodump --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_INITDB_DATABASE" --archive' \\
            | ${prExec} sh -c 'mongorestore --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --nsInclude="$MONGO_INITDB_DATABASE.*" --drop'`;
    }
  }

  const dbCloningLogic = config.hasDb ? `
      - name: Database Clone & Restore
        if: github.event.action == 'opened' || github.event.action == 'reopened'
        run: |
          # pipefail matters here: the clone is one pipe between two pods, and
          # without it a failing dump still exits 0 as long as the restore
          # command starts - producing an empty database reported as cloned.
          set -euo pipefail

          echo "Cloning database from \${{ env.MAIN_NAMESPACE }} to \${{ env.PR_NAMESPACE }}..."

          echo "Waiting for PR database to be ready..."
          kubectl rollout status statefulset/database -n \${{ env.PR_NAMESPACE }} --timeout=180s

          echo "Checking if PR database was already cloned..."
          if ! kubectl get configmap flarops-db-cloned -n \${{ env.PR_NAMESPACE }} > /dev/null 2>&1; then
            echo "Database has not been cloned yet, streaming dump straight into the PR database..."
            ${dbDumpCmd}

            echo "Marking database as cloned..."
            kubectl create configmap flarops-db-cloned -n \${{ env.PR_NAMESPACE }}

            echo "Restarting API pod to pick up restored data..."
            kubectl rollout restart deployment api -n \${{ env.PR_NAMESPACE }} || true
            kubectl rollout status deployment/api -n \${{ env.PR_NAMESPACE }} --timeout=120s || true
          else
            echo "Database was already cloned, skipping clone to preserve data."
          fi
` : '';

  const envsBlock = config.hasDb ? `  DB_USER: ${config.dbUser || 'root'}
  DB_NAME: ${config.dbName || 'appdb'}` : '';


  const domainParts = config.domain.split('.');
  let prDomainLogic;
  if (domainParts.length > 2) {
    const subdomain = domainParts[0];
    const baseDomain = domainParts.slice(1).join('.');
    prDomainLogic = `${subdomain}-pr-\${{ github.event.pull_request.number }}.${baseDomain}`;
  } else {
    prDomainLogic = `pr-\${{ github.event.pull_request.number }}.${config.domain}`;
  }

  // A rough footprint for one PR capsule, scaled by how many components this
  // project actually has. It is only a HINT: the dashboard's capacity oracle
  // adds its own headroom and compares against measured usage, so this number
  // decides nothing on its own - it just tells the oracle what size of capsule
  // to plan for. The chart no longer carries resource requests, so there is
  // nothing more precise to derive it from.
  let requiredMi = 0;
  if (config.hasBackend) requiredMi += 256;
  if (config.hasFrontend) requiredMi += 128;
  if (config.hasDb) requiredMi += 256;
  if (config.additionalServices && config.additionalServices.length > 0) requiredMi += config.additionalServices.length * 128;
  if (requiredMi === 0) requiredMi = 256;
  const requiredKi = requiredMi * 1024;

  return `name: Flarops PR Capsule

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

# Serialize workflow runs per PR (instead of cancelling in-progress ones) so an
# "opened" run's database dump/restore, and a "deploy" run's terraform apply,
# never overlap with another run for the same PR - overlapping runs previously
# could both pass the "not yet cloned" check and restore into the same database
# concurrently, or race on the shared production Terraform workspace.
# ONE capsule pipeline at a time across the whole repository, not one per PR.
#
# Keyed by PR number, two pull requests ran side by side - and both asked the
# dashboard whether a capsule fits, both got the same answer naming the same
# node, and both deployed onto it. The oracle reports what is running now; it
# cannot see a capsule another job is about to create. Scaling is worse still:
# two jobs can run "terraform apply" against one state at the same time.
#
# Serialising costs latency on busy repositories and is the only thing that
# makes the placement answer true by the time it is acted on. cancel-in-progress
# stays false: a half-applied capsule must finish, not be killed mid-converge.
concurrency:
  group: flarops-pr-capsule
  cancel-in-progress: false

env:
  AWS_REGION: ${config.awsRegion || 'us-west-2'}
  PROJECT_NAME: ${config.projectName}
  REGISTRY_USER: ${config.registryUser}
  BASE_DOMAIN: ${config.domain}
  MAIN_NAMESPACE: ${config.projectName}-production
  PR_NAMESPACE: ${config.projectName}-pr-\${{ github.event.pull_request.number }}
  PR_ENV_NAME: pr-\${{ github.event.pull_request.number }}
  PR_DOMAIN: ${prDomainLogic}
${envsBlock ? envsBlock + '\n' : ''}${registryEnv ? '  ' + registryEnv + '\n' : ''}

jobs:
  deploy-capsule:
    name: Deploy PR Capsule
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
          # Without this the job's GITHUB_TOKEN is left in .git/config, where
          # every later step - and every third-party action among them - can
          # read it. Nothing here pushes back to the repository.
          persist-credentials: false

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd # v3

      - name: Terraform Init
        working-directory: deploy/terraform
        run: terraform init

      - name: Terraform Workspace
        working-directory: deploy/terraform
        run: terraform workspace select -or-create main

      - name: Fetch Kubeconfig from EC2
        # The key is passed through the step environment, never interpolated
        # into the script text: an expression substituted into a run block
        # becomes part of the shell source the runner executes, so it lands in
        # traces and in any error the shell prints back.
        env:
          SSH_PRIVATE_KEY: \${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          mkdir -p ~/.ssh
          printf '%s\\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa

          # Retrieve EC2 IP using Terraform or from secrets if exported
          export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)

          mkdir -p ~/.kube
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
          chmod 600 ~/.kube/config

          sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config

      - name: Decide where this capsule goes
${terraformProviderEnv}        run: |
          set -euo pipefail

          # ---------------------------------------------------------------
          # 1. Is this capsule already placed?
          #
          # Every push to the PR re-runs this job. The capsule's volumes are
          # provisioned by k3s's default local-path StorageClass, whose
          # PersistentVolumes carry node affinity - they exist on one node's
          # disk and cannot follow a pod anywhere else. Asking the oracle again
          # can name a DIFFERENT node, and pinning there leaves the database
          # pod Pending forever against a volume it can never reach.
          #
          # So an existing capsule is never re-placed: where it runs now is
          # where it keeps running.
          # ---------------------------------------------------------------
          TARGET_NODE=$(kubectl get pods -n "\${{ env.PR_NAMESPACE }}" \\
            -o jsonpath='{.items[?(@.spec.nodeName)].spec.nodeName}' 2>/dev/null | tr ' ' '\\n' | head -1 || true)

          if [ -n "$TARGET_NODE" ]; then
            echo "Capsule already runs on $TARGET_NODE - keeping it there."
            echo "TARGET_NODE=$TARGET_NODE" >> "$GITHUB_ENV"
            exit 0
          fi

          # ---------------------------------------------------------------
          # 2. First placement: ask the dashboard.
          #
          # The oracle listens on loopback inside the dashboard pod with no
          # Service and no Ingress, so "kubectl exec" is the only way in - and
          # anyone who can exec already holds cluster credentials. It measures
          # real memory use, unlike node "allocatable", which only reflects
          # what the scheduler has reserved and never moves now that the chart
          # carries no resource requests.
          #
          # No size is passed: the oracle sizes the request from the largest
          # capsule actually running, which is a measurement rather than the
          # guess a generated constant would be.
          # ---------------------------------------------------------------
          ask_capacity() {
            kubectl exec -n "\${{ env.MAIN_NAMESPACE }}" deploy/flarops-dashboard -- \\
              curl -sS --max-time 10 "http://127.0.0.1:9090/capacity"
          }

          OUT=""
          for attempt in 1 2 3; do
            if OUT=$(ask_capacity 2>/tmp/capacity.err); then
              break
            fi
            echo "Capacity oracle not answering (attempt $attempt): $(cat /tmp/capacity.err)"
            OUT=""
            sleep 10
          done

          if [ -z "$OUT" ]; then
            echo "::error::Could not reach the dashboard's capacity oracle. Refusing to guess whether this capsule fits - check that the main deployment is healthy before re-running."
            exit 1
          fi

          echo "$OUT"
          VERDICT=$(printf '%s' "$OUT" | head -1)
          TARGET_NODE=$(printf '%s' "$OUT" | sed -n 's/^node=//p')

          if [ "$VERDICT" = "unknown" ]; then
            echo "::error::The dashboard has no fresh fleet data, so it cannot say whether this capsule fits. Refusing to deploy blind."
            exit 1
          fi

          # ---------------------------------------------------------------
          # 3. No room: add a worker in the lowest free slot.
          #
          # Slots are addressed individually (see worker_slots in
          # deploy/terraform/variables.tf), so adding one never disturbs the
          # others and the number chosen here is the one teardown can later
          # remove on its own.
          # ---------------------------------------------------------------
          if [ "$VERDICT" = "no" ]; then
            echo "::warning::No node has room for this capsule. Adding a worker..."

            cd deploy/terraform
            terraform init
            # The workspace MUST match the one every other step (and deploy.yml)
            # uses - the real infrastructure lives in "main". Applying in any
            # other workspace starts from an empty state and would provision a
            # second, parallel stack, repointing this domain's DNS records at a
            # brand new empty cluster.
            terraform workspace select -or-create main

            # All outputs at once: naming one that does not exist yet exits 1,
            # while an empty state answers "{}" with exit 0.
            ALL_OUTPUTS=$(terraform output -json)
            CURRENT_SLOTS=$(printf '%s' "$ALL_OUTPUTS" | python3 -c "import json,sys; v=json.load(sys.stdin).get('worker_slots',{}).get('value',[]); print(json.dumps(v if isinstance(v,list) else []))")
            # Lowest unused slot, so a reclaimed number is reused rather than
            # the set growing forever.
            NEW_SLOTS=$(printf '%s' "$CURRENT_SLOTS" | python3 -c "import json,sys; s=[int(x) for x in json.load(sys.stdin)]; f=next(n for n in range(1,1000) if n not in s); print(json.dumps(sorted(s+[f])))")
            echo "Worker slots $CURRENT_SLOTS -> $NEW_SLOTS"
            terraform apply -var="worker_slots=$NEW_SLOTS" -auto-approve
            EC2_IP=$(terraform output -raw public_ip)
            cd - > /dev/null

            echo "Waiting for the new worker to join..."
            ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo k3s kubectl wait --for=condition=Ready node --all --timeout=180s"

            # The new node is Ready before metrics-server has measured it, and
            # the oracle refuses to place onto a node it cannot measure - so
            # keep asking until it can.
            TARGET_NODE=""
            for attempt in 1 2 3 4 5 6 7 8; do
              sleep 15
              OUT=$(ask_capacity 2>/dev/null || true)
              if [ "$(printf '%s' "$OUT" | head -1)" = "yes" ]; then
                TARGET_NODE=$(printf '%s' "$OUT" | sed -n 's/^node=//p')
                echo "$OUT"
                break
              fi
            done

            if [ -z "$TARGET_NODE" ]; then
              echo "::error::A worker was added but no node reports room for this capsule. Not deploying onto a node that cannot hold it."
              exit 1
            fi
          fi

          if [ -z "$TARGET_NODE" ]; then
            echo "::error::The capacity oracle said yes but named no node."
            exit 1
          fi

          echo "Capsule will be placed on $TARGET_NODE"
          echo "TARGET_NODE=$TARGET_NODE" >> "$GITHUB_ENV"

      - name: Setup Werf
        uses: werf/actions/install@49e2d1cf7fcda661767ee6d8205f3fb4687e684d # branch v2 @ 2026-05-21
${loginStep}
      - name: Deploy application with Werf
        env:
${secretEnvBlock}${dbPasswordEnvLine}          SECRET_REGISTRY_PASSWORD: \${{ secrets.REGISTRY_PASSWORD }}
          REGISTRY_SERVER: ${registryServerForPull}
        run: |
          umask 077
          # Read the instance shape back out of Terraform - the single place
          # it is declared (deploy/terraform/variables.tf).
          export TF_INSTANCE_TYPE=$(terraform -chdir=deploy/terraform output -raw instance_type 2>/dev/null || true)
          export TF_VOLUME_SIZE=$(terraform -chdir=deploy/terraform output -raw volume_size 2>/dev/null || true)
          ${buildValuesScript}
          werf converge \\
            --parallel-tasks-limit=3 \\
            --repo ${repoString} \\
            --env \${{ env.PR_ENV_NAME }} \\
            --set domain=\${{ env.PR_DOMAIN }} \\
            --set "dataNodeSelector.kubernetes\\.io/hostname=$TARGET_NODE" \\
            --values deploy/helm/flarops-ci-values.json${loginRegistryHost === 'docker.io' ? '' : `

      - name: Cleanup old images
        run: |
          werf cleanup \\
            --repo ${repoString}`}
${dbCloningLogic}
  cleanup-capsule:
    name: Teardown PR Capsule
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
          # Without this the job's GITHUB_TOKEN is left in .git/config, where
          # every later step - and every third-party action among them - can
          # read it. Nothing here pushes back to the repository.
          persist-credentials: false

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a # v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd # v3

      - name: Terraform Init
        working-directory: deploy/terraform
        run: terraform init

      - name: Terraform Workspace
        working-directory: deploy/terraform
        run: terraform workspace select -or-create main

      - name: Fetch Kubeconfig from EC2
        # The key is passed through the step environment, never interpolated
        # into the script text: an expression substituted into a run block
        # becomes part of the shell source the runner executes, so it lands in
        # traces and in any error the shell prints back.
        env:
          SSH_PRIVATE_KEY: \${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          mkdir -p ~/.ssh
          printf '%s\\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa

          export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)

          mkdir -p ~/.kube
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
          chmod 600 ~/.kube/config

          sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config

      - name: Setup Werf
        uses: werf/actions/install@49e2d1cf7fcda661767ee6d8205f3fb4687e684d # branch v2 @ 2026-05-21
${loginStep}
      - name: Dismiss application with Werf
        # A PR whose deploy never succeeded has no release to dismiss, and werf
        # exits non-zero on one that is not there. That failure used to abort
        # the job before the scale-down step below, so the worker a failed
        # capsule had triggered stayed provisioned - and kept being billed -
        # until someone noticed.
        continue-on-error: true
        run: |
          werf dismiss \\
            --repo ${repoString} \\
            --env \${{ env.PR_ENV_NAME }} \\
            --with-namespace

      - name: Reclaim idle worker nodes
${terraformProviderEnv}        run: |
          set -euo pipefail

          cd deploy/terraform
          terraform init
          # Same workspace as every other step - the real infrastructure lives
          # in "main".
          terraform workspace select -or-create main
          if ! ALL_OUTPUTS=$(terraform output -json 2>&1); then
            echo "::error::Could not read Terraform outputs: $ALL_OUTPUTS"
            exit 1
          fi
          CURRENT_SLOTS=$(printf '%s' "$ALL_OUTPUTS" | python3 -c "import json,sys; v=json.load(sys.stdin).get('worker_slots',{}).get('value',[]); print(json.dumps(v if isinstance(v,list) else []))")
          INSTANCE_NAME=$(printf '%s' "$ALL_OUTPUTS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('instance_name',{}).get('value',''))")
          cd - > /dev/null

          if [ "$CURRENT_SLOTS" = "[]" ]; then
            echo "No worker nodes to reclaim."
            exit 0
          fi
          if [ -z "$INSTANCE_NAME" ]; then
            echo "::error::Could not read instance_name from Terraform. Refusing to guess node names - a wrong guess drains a node that is carrying work."
            exit 1
          fi

          # Node names are DERIVED from the same Terraform values that set the
          # instance hostnames, not reconstructed from the project name here.
          # The old code built "<project>-instance-worker-N" by hand; the real
          # name comes from var.instance_name, which an operator may change.
          # When the two drifted, every lookup matched nothing, every node
          # looked idle, and nodes carrying live capsules were drained.
          #
          # A node is only reclaimed when kubectl SUCCEEDS and reports zero
          # non-system pods. pipefail is what makes that true: without it a
          # failed kubectl still ended the pipeline with "0" from wc, and an
          # unreachable cluster read as "everything is idle".
          FREED=""
          for SLOT in $(printf '%s' "$CURRENT_SLOTS" | python3 -c "import json,sys; print(' '.join(str(s) for s in sorted((int(x) for x in json.load(sys.stdin)), reverse=True)))"); do
            NODE_NAME="\${INSTANCE_NAME}-worker-\${SLOT}"
            echo "Checking $NODE_NAME ..."

            if ! RAW=$(kubectl get pods --all-namespaces --field-selector "spec.nodeName=$NODE_NAME" --no-headers 2>&1); then
              echo "  could not query pods on $NODE_NAME ($RAW) - leaving it alone."
              continue
            fi
            PODS=$(printf '%s' "$RAW" | grep -v '^$' | grep -cv '^kube-system ' || true)

            if [ "$PODS" -ne 0 ]; then
              echo "  $PODS active pod(s) - keeping it."
              continue
            fi

            echo "  idle - draining and removing."
            kubectl drain "$NODE_NAME" --ignore-daemonsets --delete-emptydir-data --force --timeout=120s || true
            kubectl delete node "$NODE_NAME" --ignore-not-found
            FREED="$FREED $SLOT"
          done

          if [ -z "$FREED" ]; then
            echo "Nothing to reclaim."
            exit 0
          fi

          # Slots are addressed individually, so any idle worker can go - a
          # busy node no longer blocks reclaiming an idle one below it, which
          # is what kept paying for nodes nobody was using.
          NEW_SLOTS=$(FREED="$FREED" CURRENT="$CURRENT_SLOTS" python3 -c "import json,os; c=[int(x) for x in json.loads(os.environ['CURRENT'])]; f={int(x) for x in os.environ['FREED'].split()}; print(json.dumps(sorted(s for s in c if s not in f)))")
          echo "Worker slots $CURRENT_SLOTS -> $NEW_SLOTS"
          cd deploy/terraform
          terraform apply -var="worker_slots=$NEW_SLOTS" -auto-approve
`;
};
