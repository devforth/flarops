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

  const buildValuesScript = `python3 -c "import json,os; data={'env': {k[len('SECRET_ENV_'):]: v for k,v in os.environ.items() if k.startswith('SECRET_ENV_')}, 'database': {'password': os.environ.get('SECRET_DB_PASSWORD','')}}; open('deploy/helm/flarops-ci-values.json','w').write(json.dumps(data))"`;

  // See templates/deploy.yml.js for why this is gated on hasDbPassword instead
  // of always referencing a "DATABASE_PASSWORD" secret that may not exist.
  const dbPasswordEnvLine = config.hasDbPassword ? `          SECRET_DB_PASSWORD: \${{ secrets.${config.dbPasswordKey} }}\n` : '';

  let dbDumpCmd = '';
  let dbRestoreCmd = '';

  if (config.hasDb) {
    if (config.dbType === 'postgres') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- pg_dump -U \${{ env.DB_USER }} \${{ env.DB_NAME }} > dump.sql`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- psql -U \${{ env.DB_USER }} \${{ env.DB_NAME }} < dump.sql`;
    } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- mysqldump -u \${{ env.DB_USER }} -p\${{ secrets.${config.dbPasswordKey} }} \${{ env.DB_NAME }} > dump.sql`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- mysql -u \${{ env.DB_USER }} -p\${{ secrets.${config.dbPasswordKey} }} \${{ env.DB_NAME }} < dump.sql`;
    } else if (config.dbType === 'mongodb') {
      const mongoAuth = `-u \${{ env.DB_USER }} -p \${{ secrets.${config.dbPasswordKey} }} --authenticationDatabase admin`;
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- mongodump ${mongoAuth} --db \${{ env.DB_NAME }} --archive > dump.archive`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- mongorestore ${mongoAuth} --archive --nsInclude="\${{ env.DB_NAME }}.*" --drop < dump.archive`;
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
  AWS_REGION: us-west-2
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
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
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

            # Apply terraform
            cd deploy/terraform
            terraform init
            terraform workspace select -or-create production

            # Execute scale up
            terraform apply -var="worker_count=$NEW_WORKERS" -auto-approve

            echo "Waiting for new worker node to join the cluster..."
            sleep 45

            export EC2_IP=$(terraform -chdir=deploy/terraform output -raw public_ip)
            ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "kubectl wait --for=condition=Ready node --all --timeout=120s"
          else
            echo "Sufficient resources available. Proceeding with deployment."
          fi

      - name: Setup Werf
        uses: werf/actions/install@v2
${loginStep}
      - name: Deploy application with Werf
${(secretEnvBlock || dbPasswordEnvLine) ? '        env:\n' + secretEnvBlock + dbPasswordEnvLine : ''}        run: |
          umask 077
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
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
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
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "bash -s" << 'EOF'
            CURRENT_WORKERS=$(kubectl get nodes -l node-role.kubernetes.io/master!=true --no-headers 2>/dev/null | wc -l || echo "0")
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

              PODS=$(kubectl get pods --field-selector spec.nodeName=$NODE_NAME --all-namespaces --no-headers 2>/dev/null | grep -v "kube-system" | wc -l || echo "0")

              if [ "$PODS" -eq 0 ]; then
                echo "Node $NODE_NAME is idle! Draining..."
                kubectl drain $NODE_NAME --ignore-daemonsets --delete-emptydir-data --force || true
                kubectl delete node $NODE_NAME || true
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
            terraform workspace select -or-create production
            terraform apply -var="worker_count=$NEW_WORKERS" -auto-approve
          fi
`;
};
