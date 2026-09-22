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
        uses: docker/login-action@v3
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
  let dbRestoreCmd = '';

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

  if (config.hasDb) {
    if (config.dbType === 'postgres') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- sh -c 'PGPASSWORD="$${dbPasswordEnvVarInContainer}" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > dump.sql`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- sh -c 'PGPASSWORD="$${dbPasswordEnvVarInContainer}" psql -U "$POSTGRES_USER" "$POSTGRES_DB"' < dump.sql`;
    } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      // MYSQL_PWD keeps the password out of the argument list, so it is not
      // visible in the database pod's process table either.
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- sh -c 'MYSQL_PWD="$${dbPasswordEnvVarInContainer}" mysqldump --single-transaction -u root "\${{ env.DB_NAME }}"' > dump.sql`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- sh -c 'MYSQL_PWD="$${dbPasswordEnvVarInContainer}" mysql -u root "\${{ env.DB_NAME }}"' < dump.sql`;
    } else if (config.dbType === 'mongodb') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$${dbPasswordEnvVarInContainer}" --authenticationDatabase admin --db "\${{ env.DB_NAME }}" --archive' > dump.archive`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$${dbPasswordEnvVarInContainer}" --authenticationDatabase admin --archive --nsInclude="\${{ env.DB_NAME }}.*" --drop' < dump.archive`;
    }
  }

  const dbCloningLogic = config.hasDb ? `
      - name: Database Clone & Restore
        if: github.event.action == 'opened' || github.event.action == 'reopened'
        run: |
          echo "Cloning database from \${{ env.MAIN_NAMESPACE }} to \${{ env.PR_NAMESPACE }}..."

          # Wait for PR database to be ready
          echo "Waiting for PR database to be ready..."
          kubectl rollout status statefulset/database -n \${{ env.PR_NAMESPACE }} --timeout=120s

          # Check if DB has been cloned before
          echo "Checking if PR database was already cloned..."
          if ! kubectl get configmap flarops-db-cloned -n \${{ env.PR_NAMESPACE }} > /dev/null 2>&1; then
            echo "Database has not been cloned yet, performing dump & restore..."
            ${dbDumpCmd}

            echo "Restoring to PR database..."
            ${dbRestoreCmd}

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

  // Required memory for one PR capsule, computed from what this project's Helm
  // chart actually requests per component (api 256Mi, frontend 128Mi, database
  // 256Mi, each additional service 128Mi - see templates/*/deployment.js) rather
  // than a hardcoded constant that silently drifted from the real chart whenever
  // a project had additionalServices.
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
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3

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

      - name: Verify Cluster Resources & Autoscale
        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          echo "Checking available resources on Kubernetes cluster..."

          CAPACITY_KI=$(kubectl get nodes -o jsonpath='{.items[*].status.capacity.memory}' | sed 's/Ki//g' | awk '{sum=0; for(i=1; i<=NF; i++) sum+=$i; print sum}')
          ALLOCATABLE_KI=$(kubectl get nodes -o jsonpath='{.items[*].status.allocatable.memory}' | sed 's/Ki//g' | awk '{sum=0; for(i=1; i<=NF; i++) sum+=$i; print sum}')

          if ! [[ "$ALLOCATABLE_KI" =~ ^[0-9]+$ ]]; then
            echo "::error::Could not read allocatable memory from the cluster (got '$ALLOCATABLE_KI'). Refusing to guess - check that the kubeconfig fetched above is valid before re-running."
            exit 1
          fi

          echo "Total Capacity: \${CAPACITY_KI} Ki"
          echo "Allocatable (after k3s/system reservation): \${ALLOCATABLE_KI} Ki"

          BUFFER_KI=$((CAPACITY_KI * 20 / 100))
          echo "20% Safety Buffer: \${BUFFER_KI} Ki"

          AVAILABLE_KI=$((ALLOCATABLE_KI - BUFFER_KI))

          # Required memory for this PR capsule, computed at generation time from the
          # project's actual Helm resource requests (api/frontend/database/additional
          # services) - see templates/pr-capsule.yml.js.
          REQUIRED_KI=${requiredKi}

          echo "Available RAM (with buffer): \${AVAILABLE_KI} Ki"
          echo "Required RAM for PR Capsule: \${REQUIRED_KI} Ki"

          if [ "$AVAILABLE_KI" -lt "$REQUIRED_KI" ]; then
            echo "::warning::Insufficient cluster resources. Triggering horizontal autoscaling..."
            # Count current worker nodes
            CURRENT_WORKERS=$(kubectl get nodes -l node-role.kubernetes.io/master!=true --no-headers 2>/dev/null | wc -l || echo "0")
            NEW_WORKERS=$((CURRENT_WORKERS + 1))
            echo "Scaling from $CURRENT_WORKERS to $NEW_WORKERS workers."

            # Apply terraform. The workspace MUST match the one every other
            # step (and deploy.yml) uses - the real infrastructure lives in
            # "main". Applying in any other workspace starts from an empty
            # state and would provision a second, parallel stack, repointing
            # this domain's DNS records at a brand new empty cluster.
            cd deploy/terraform
            terraform init
            terraform workspace select -or-create main

            # Execute scale up
            terraform apply -var="worker_count=$NEW_WORKERS" -auto-approve

            echo "Waiting for new worker node to join the cluster..."
            sleep 45

            # Already inside deploy/terraform after the cd above - a second
            # -chdir would resolve to deploy/terraform/deploy/terraform.
            export EC2_IP=$(terraform output -raw public_ip)
            cd - > /dev/null
            ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo k3s kubectl wait --for=condition=Ready node --all --timeout=120s"
          else
            echo "Sufficient resources available. Proceeding with deployment."
          fi

      - name: Setup Werf
        uses: werf/actions/install@v2
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
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3

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
        uses: werf/actions/install@v2
${loginStep}
      - name: Dismiss application with Werf
        run: |
          werf dismiss \\
            --repo ${repoString} \\
            --env \${{ env.PR_ENV_NAME }} \\
            --with-namespace

      - name: Check and Scale Down Idle Nodes
        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)
          # Everything inside this heredoc runs ON the k3s server as "ubuntu",
          # which cannot read /etc/rancher/k3s/k3s.yaml (root-owned, 0600) -
          # a plain "kubectl" there fails, and because every call below is
          # error-tolerant the failure used to be swallowed as "0 workers",
          # silently disabling scale-down forever. "sudo k3s kubectl" uses
          # k3s's own bundled client and its root-readable config instead.
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "bash -s" << 'EOF'
            CURRENT_WORKERS=$(sudo k3s kubectl get nodes -l node-role.kubernetes.io/master!=true --no-headers 2>/dev/null | wc -l || echo "0")
            if [ "$CURRENT_WORKERS" -eq 0 ]; then
              echo "No worker nodes to scale down."
              echo "SCALE_DOWN=false" > /tmp/scale_down.env
              exit 0
            fi

            # Terraform's count-based worker instances can only be safely removed from
            # the top of the index down (reducing worker_count destroys the highest
            # index first), so we walk down from the newest worker and reclaim every
            # *contiguous* idle node starting at the top. A busy top node still blocks
            # reclaiming an idle lower-numbered one - that would require switching
            # worker instances to individually-addressable resources (e.g. for_each),
            # which is a bigger change than an automatic teardown step should make.
            REMOVED=0
            IDX=$CURRENT_WORKERS
            while [ "$IDX" -gt 0 ]; do
              NODE_NAME="${config.projectName}-instance-worker-$IDX"
              echo "Checking if node $NODE_NAME is idle..."

              PODS=$(sudo k3s kubectl get pods --field-selector spec.nodeName=$NODE_NAME --all-namespaces --no-headers 2>/dev/null | grep -v "kube-system" | wc -l || echo "0")

              if [ "$PODS" -eq 0 ]; then
                echo "Node $NODE_NAME is idle! Draining..."
                sudo k3s kubectl drain $NODE_NAME --ignore-daemonsets --delete-emptydir-data --force || true
                sudo k3s kubectl delete node $NODE_NAME || true
                echo "Node $NODE_NAME successfully removed from K3s."
                REMOVED=$((REMOVED + 1))
                IDX=$((IDX - 1))
              else
                echo "Node $NODE_NAME has $PODS active pods. Stopping scale-down scan."
                break
              fi
            done

            if [ "$REMOVED" -gt 0 ]; then
              echo "SCALE_DOWN=true" > /tmp/scale_down.env
              echo "NEW_WORKERS=$((CURRENT_WORKERS - REMOVED))" >> /tmp/scale_down.env
            else
              echo "SCALE_DOWN=false" > /tmp/scale_down.env
            fi
          EOF

          scp -o StrictHostKeyChecking=no ubuntu@$EC2_IP:/tmp/scale_down.env ./scale_down.env
          source ./scale_down.env

          if [ "$SCALE_DOWN" == "true" ]; then
            echo "Triggering terraform apply to scale down..."
            cd deploy/terraform
            terraform init
            # Same workspace as every other step - see the scale-up note above.
            terraform workspace select -or-create main
            terraform apply -var="worker_count=$NEW_WORKERS" -auto-approve
          fi
`;
};
