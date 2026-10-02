const ciSsh = require('./ciSsh');

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
        uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9
        with:
          registry: ${loginRegistryHost}
          username: \${{ env.REGISTRY_USER }}
          password: \${{ secrets.REGISTRY_PASSWORD }}`;

  const secretEnvBlock = config.envKeysToPass && config.envKeysToPass.length > 0
    ? config.envKeysToPass.map(k => `          SECRET_ENV_${k}: \${{ secrets.${k} }}`).join('\n') + '\n'
    : '';

  const registryServerForPull = config.dockerRegistry ? config.dockerRegistry.split('/')[0] : 'https://index.docker.io/v1/';

  const buildValuesScript = `python3 -c "import json,os; data={'env': {k[len('SECRET_ENV_'):]: v for k,v in os.environ.items() if k.startswith('SECRET_ENV_')}, 'database': {'password': os.environ.get('SECRET_DB_PASSWORD','')}}; reg=os.environ.get('SECRET_REGISTRY_PASSWORD',''); data.update({'imagePullSecret': {'server': os.environ.get('REGISTRY_SERVER',''), 'username': os.environ.get('REGISTRY_USER',''), 'password': reg}} if reg else {}); aws={k:v for k,v in (('instanceType',os.environ.get('TF_INSTANCE_TYPE','')),('volumeSize',os.environ.get('TF_VOLUME_SIZE',''))) if v}; data.update({'aws': aws} if aws else {}); open('deploy/helm/flarops-ci-values.json','w').write(json.dumps(data))"`;

  const dbPasswordEnvLine = config.hasDbPassword ? `          SECRET_DB_PASSWORD: \${{ secrets.${config.dbPasswordKey} }}\n` : '';

  let dbDumpCmd = '';

  // Passwords are never interpolated into these shell strings: the variable expands inside the
  // database pod, from that pod's own env.
  const dbPasswordEnvVarInContainer = {
    postgres: 'POSTGRES_PASSWORD',
    postgresql: 'POSTGRES_PASSWORD',
    mysql: 'MYSQL_ROOT_PASSWORD',
    mariadb: 'MARIADB_ROOT_PASSWORD',
    mongodb: 'MONGO_INITDB_ROOT_PASSWORD'
  }[config.dbType];

  // Streamed pod to pod; nothing lands on the runner.
  const terraformProviderEnv = `        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
`;

  // Repository values are written as single-line quoted scalars, never raw.
  const yamlScalar = (value) => JSON.stringify(String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim());

  const mainExec = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 --`;
  const prExec = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 --`;

  if (config.hasDb) {
    if (config.dbType === 'postgres' || config.dbType === 'postgresql') {
      // ON_ERROR_STOP makes psql fail on a bad statement instead of skipping it.
      dbDumpCmd = `${mainExec} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \\
            | ${prExec} sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`;
    } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      // MariaDB 11 ships only mariadb-* binaries, MySQL only mysql*: resolved at runtime.
      const passVar = config.dbType === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
      const dbVar = config.dbType === 'mariadb' ? 'MARIADB_DATABASE' : 'MYSQL_DATABASE';
      // MYSQL_PWD keeps the password out of the process table.
      dbDumpCmd = `${mainExec} sh -c 'MYSQL_PWD="$${passVar}" $(command -v mariadb-dump || command -v mysqldump) --single-transaction --routines --triggers -u root "$${dbVar}"' \\
            | ${prExec} sh -c 'MYSQL_PWD="$${passVar}" $(command -v mariadb || command -v mysql) -u root "$${dbVar}"'`;
    } else if (config.dbType === 'mongodb') {
      dbDumpCmd = `${mainExec} sh -c 'mongodump --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_INITDB_DATABASE" --archive' \\
            | ${prExec} sh -c 'mongorestore --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --nsInclude="$MONGO_INITDB_DATABASE.*" --drop'`;
    }
  }

  const dbCloningLogic = config.hasDb ? `
      - name: Database Clone & Restore
        run: |
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

  const envsBlock = config.hasDb ? `  DB_USER: ${yamlScalar(config.dbUser || 'root')}
  DB_NAME: ${yamlScalar(config.dbName || 'appdb')}` : '';

  const domainParts = config.domain.split('.');
  let prDomainLogic;
  if (domainParts.length > 2) {
    const subdomain = domainParts[0];
    const baseDomain = domainParts.slice(1).join('.');
    prDomainLogic = `${subdomain}-pr-\${{ github.event.pull_request.number }}.${baseDomain}`;
  } else {
    prDomainLogic = `pr-\${{ github.event.pull_request.number }}.${config.domain}`;
  }

  // FALLBACK capsule size, used only when production cannot be measured yet.
  let requiredMi = 0;
  if (config.hasBackend) requiredMi += 256;
  if (config.hasFrontend) requiredMi += 128;
  if (config.hasDb) requiredMi += 256;
  if (config.additionalServices && config.additionalServices.length > 0) requiredMi += config.additionalServices.length * 128;
  if (requiredMi === 0) requiredMi = 256;

  return `name: Flarops PR Capsule

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read

concurrency:
  group: flarops-pr-capsule-\${{ github.event.pull_request.number }}
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
    timeout-minutes: 45
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd

      - name: Terraform Init
        working-directory: deploy/terraform
        run: terraform init

      - name: Terraform Workspace
        working-directory: deploy/terraform
        run: terraform workspace select -or-create main

      - name: Fetch Kubeconfig from EC2
        env:
          SSH_PRIVATE_KEY: \${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          set -euo pipefail

          mkdir -p ~/.ssh
          printf '%s\\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa

          export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)

${ciSsh.fetchKubeconfig()}

      - name: Decide where this capsule goes
${terraformProviderEnv}        run: |
          set -euo pipefail

${ciSsh.helpers()}

          TARGET_NODE=$(kubectl get pods -n "\${{ env.PR_NAMESPACE }}" \\
            -l component=database -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)

          if [ -n "$TARGET_NODE" ]; then
            echo "Capsule already runs on $TARGET_NODE - keeping it there."
            echo "TARGET_NODE=$TARGET_NODE" >> "$GITHUB_ENV"
            exit 0
          fi

          REQUIRED_MI=$(kubectl top pods -n "\${{ env.MAIN_NAMESPACE }}" --no-headers 2>/dev/null \\
            | awk '$1 !~ /^flarops-(dashboard|node-agent)/ { v = $3; if (v ~ /Gi$/) { sub(/Gi$/, "", v); v = v * 1024 } else if (v ~ /Ki$/) { sub(/Ki$/, "", v); v = v / 1024 } else { sub(/Mi$/, "", v) } s += v } END { printf "%d", s }' || true)
          if [ -z "$REQUIRED_MI" ] || [ "$REQUIRED_MI" -lt 64 ]; then
            echo "No usable measurement of \${{ env.MAIN_NAMESPACE }} yet - planning with the generated estimate of ${requiredMi} MiB."
            REQUIRED_MI=${requiredMi}
          else
            echo "Planning this capsule at $REQUIRED_MI MiB - what the same stack uses in \${{ env.MAIN_NAMESPACE }} right now."
          fi

          ask_capacity() {
            kubectl exec -n "\${{ env.MAIN_NAMESPACE }}" deploy/flarops-dashboard -- \\
              curl -sS --max-time 10 "http://127.0.0.1:9090/capacity?mib=$REQUIRED_MI&for=\${{ env.PR_ENV_NAME }}"
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

          if [ "$VERDICT" = "no" ]; then
            TF_OUTPUTS=$(terraform -chdir=deploy/terraform output -json 2>/dev/null || echo '{}')
            KNOWN_SLOTS=$(printf '%s' "$TF_OUTPUTS" | python3 -c "import json,sys; v=json.load(sys.stdin).get('worker_slots',{}).get('value',[]); print(' '.join(str(s) for s in (v if isinstance(v,list) else [])))")
            WORKER_PREFIX=$(printf '%s' "$TF_OUTPUTS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('instance_name',{}).get('value',''))")
            node_ready() {
              [ "$(kubectl get node "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)" = "True" ]
            }
            JOINING=""
            if [ -n "$WORKER_PREFIX" ]; then
              for SLOT in $KNOWN_SLOTS; do
                if ! node_ready "$WORKER_PREFIX-worker-$SLOT"; then JOINING="$JOINING $WORKER_PREFIX-worker-$SLOT"; fi
              done
            fi
            if [ -n "$JOINING" ]; then
              echo "Workers still joining:$JOINING - waiting for them before adding another."
              for attempt in $(seq 1 60); do
                STILL=""
                for NODE in $JOINING; do
                  if ! node_ready "$NODE"; then STILL="$STILL $NODE"; fi
                done
                if [ -z "$STILL" ]; then break; fi
                echo "  still joining:$STILL ($attempt/60)"
                sleep 10
              done
              for attempt in 1 2 3 4 5 6 7 8; do
                OUT=$(ask_capacity 2>/dev/null || true)
                if [ "$(printf '%s' "$OUT" | head -1)" = "yes" ]; then
                  VERDICT=yes
                  TARGET_NODE=$(printf '%s' "$OUT" | sed -n 's/^node=//p')
                  echo "$OUT"
                  break
                fi
                sleep 15
              done
            fi
          fi

          if [ "$VERDICT" = "no" ]; then
            echo "::warning::No node has room for this capsule. Adding a worker..."

            cd deploy/terraform
            terraform init
            terraform workspace select -or-create main

            ALL_OUTPUTS=$(terraform output -json)
            CURRENT_SLOTS=$(printf '%s' "$ALL_OUTPUTS" | python3 -c "import json,sys; v=json.load(sys.stdin).get('worker_slots',{}).get('value',[]); print(json.dumps(v if isinstance(v,list) else []))")
            NEW_SLOTS=$(printf '%s' "$CURRENT_SLOTS" | python3 -c "import json,sys; s=[int(x) for x in json.load(sys.stdin)]; f=next(n for n in range(1,1000) if n not in s); print(json.dumps(sorted(s+[f])))")
            echo "Worker slots $CURRENT_SLOTS -> $NEW_SLOTS"
            terraform apply -var="worker_slots=$NEW_SLOTS" -auto-approve -lock-timeout=5m
            EC2_IP=$(terraform output -raw public_ip)
            cd - > /dev/null

            echo "Waiting for the new worker to join..."
            NEW_SLOT=$(CURRENT_SLOTS="$CURRENT_SLOTS" NEW_SLOTS="$NEW_SLOTS" python3 -c "import json,os; print(sorted(set(json.loads(os.environ['NEW_SLOTS'])) - set(json.loads(os.environ['CURRENT_SLOTS'])))[0])")
            NEW_NODE="\${INSTANCE_NAME:-}"
            if [ -z "$NEW_NODE" ]; then NEW_NODE=$(terraform -chdir=deploy/terraform output -raw instance_name); fi
            NEW_NODE="\${NEW_NODE}-worker-\${NEW_SLOT}"
            echo "Waiting for $NEW_NODE to join..."
            flarops_wait_for_k3s "$EC2_IP"
            NODE_SEEN=""
            for attempt in $(seq 1 60); do
              if flarops_ssh "$EC2_IP" "sudo k3s kubectl get node/\${NEW_NODE}" > /dev/null 2>&1; then NODE_SEEN=yes; break; fi
              echo "  $NEW_NODE not registered yet ($attempt/60)"
              sleep 10
            done
            if [ -z "$NODE_SEEN" ]; then
              echo "::error::$NEW_NODE never registered with the cluster within 10 minutes. The instance exists (and is billed) - check its cloud-init log (/var/log/flarops-bootstrap.log on the worker)."
              exit 1
            fi
            flarops_ssh "$EC2_IP" "sudo k3s kubectl wait --for=condition=Ready node/\${NEW_NODE} --timeout=240s"

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
        uses: werf/actions/install@49e2d1cf7fcda661767ee6d8205f3fb4687e684d
${loginStep}
      - name: Deploy application with Werf
        env:
${secretEnvBlock}${dbPasswordEnvLine}          SECRET_REGISTRY_PASSWORD: \${{ secrets.REGISTRY_PASSWORD }}
          REGISTRY_SERVER: ${registryServerForPull}
        run: |
          umask 077
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
    timeout-minutes: 45
    steps:
      - name: Checkout code
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd

      - name: Terraform Init
        working-directory: deploy/terraform
        run: terraform init

      - name: Terraform Workspace
        working-directory: deploy/terraform
        run: terraform workspace select -or-create main

      - name: Fetch Kubeconfig from EC2
        env:
          SSH_PRIVATE_KEY: \${{ secrets.SSH_PRIVATE_KEY }}
        run: |
          set -euo pipefail

          mkdir -p ~/.ssh
          printf '%s\\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa

          export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)

${ciSsh.fetchKubeconfig()}

      - name: Setup Werf
        uses: werf/actions/install@49e2d1cf7fcda661767ee6d8205f3fb4687e684d
${loginStep}
      - name: Dismiss application with Werf
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

          FREED=""
          for SLOT in $(printf '%s' "$CURRENT_SLOTS" | python3 -c "import json,sys; print(' '.join(str(s) for s in sorted((int(x) for x in json.load(sys.stdin)), reverse=True)))"); do
            NODE_NAME="\${INSTANCE_NAME}-worker-\${SLOT}"
            echo "Checking $NODE_NAME ..."

            if ! RAW=$(kubectl get pods --all-namespaces --field-selector "spec.nodeName=$NODE_NAME" -o json 2>/tmp/kubectl.err); then
              echo "  could not query pods on $NODE_NAME ($(cat /tmp/kubectl.err)) - leaving it alone."
              continue
            fi
            PODS=$(printf '%s' "$RAW" | python3 -c "
          import json, sys
          busy = [p for p in json.load(sys.stdin)['items']
                  if p['metadata']['namespace'] != 'kube-system'
                  and not p['metadata'].get('deletionTimestamp')
                  and p.get('status', {}).get('phase') not in ('Succeeded', 'Failed')
                  and not any(o.get('kind') == 'DaemonSet' for o in p['metadata'].get('ownerReferences', []))]
          print(len(busy))")

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

          NEW_SLOTS=$(FREED="$FREED" CURRENT="$CURRENT_SLOTS" python3 -c "import json,os; c=[int(x) for x in json.loads(os.environ['CURRENT'])]; f={int(x) for x in os.environ['FREED'].split()}; print(json.dumps(sorted(s for s in c if s not in f)))")
          echo "Worker slots $CURRENT_SLOTS -> $NEW_SLOTS"
          cd deploy/terraform
          terraform apply -var="worker_slots=$NEW_SLOTS" -auto-approve -lock-timeout=5m
`;
};
