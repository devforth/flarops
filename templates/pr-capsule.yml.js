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

  const setEnvs = config.envKeysToPass && config.envKeysToPass.length > 0
    ? config.envKeysToPass.map(k => `            --set env.${k}=\${{ secrets.${k} }}`).join(' \\\n') + ' \\\n'
    : '';

  let dbDumpCmd = '';
  let dbRestoreCmd = '';
  let checkDbEmptyCmd = '';

  if (config.hasDb) {
    if (config.dbType === 'postgres') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- pg_dump -U \${{ env.DB_USER }} \${{ env.DB_NAME }} > dump.sql`;
      checkDbEmptyCmd = `kubectl exec -n \${{ env.PR_NAMESPACE }} database-0 -- psql -U \${{ env.DB_USER }} \${{ env.DB_NAME }} -c "\\dt" | grep "No relations found."`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- psql -U \${{ env.DB_USER }} \${{ env.DB_NAME }} < dump.sql`;
    } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- mysqldump -u \${{ env.DB_USER }} -p\${{ secrets.${config.dbPasswordKey} }} \${{ env.DB_NAME }} > dump.sql`;
      checkDbEmptyCmd = `kubectl exec -n \${{ env.PR_NAMESPACE }} database-0 -- mysql -u \${{ env.DB_USER }} -p\${{ secrets.${config.dbPasswordKey} }} -e "SHOW TABLES IN \${{ env.DB_NAME }};" | wc -l | grep "^0$"`;
      dbRestoreCmd = `kubectl exec -i -n \${{ env.PR_NAMESPACE }} database-0 -- mysql -u \${{ env.DB_USER }} -p\${{ secrets.${config.dbPasswordKey} }} \${{ env.DB_NAME }} < dump.sql`;
    } else if (config.dbType === 'mongodb') {
      const mongoAuth = config.dbUser ? `-u \${{ env.DB_USER }} -p \${{ secrets.${config.dbPasswordKey} }} --authenticationDatabase admin` : '';
      dbDumpCmd = `kubectl exec -n \${{ env.MAIN_NAMESPACE }} database-0 -- mongodump ${mongoAuth} --db \${{ env.DB_NAME }} --archive > dump.archive`;
      checkDbEmptyCmd = `kubectl exec -n \${{ env.PR_NAMESPACE }} database-0 -- mongosh \${{ env.DB_NAME }} --quiet --eval "db.getCollectionNames().length" | grep "^0$"`;
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
          
          # Check if DB is empty
          echo "Checking if PR database is empty..."
          if ${checkDbEmptyCmd} > /dev/null 2>&1 || true; then
            echo "Database seems empty, performing dump & restore..."
            ${dbDumpCmd}
            
            echo "Restoring to PR database..."
            ${dbRestoreCmd}
            
            echo "Restarting API pod to pick up restored data..."
            kubectl rollout restart deployment api -n \${{ env.PR_NAMESPACE }}
            kubectl rollout status deployment/api -n \${{ env.PR_NAMESPACE }} --timeout=120s
          else
            echo "Database is not empty, skipping clone to preserve data."
          fi
` : '';

  const envsBlock = config.hasDb ? `  DB_USER: ${config.dbUser || 'root'}
  DB_NAME: ${config.dbName || 'appdb'}` : '';

  return \`name: Flarops PR Capsule

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

env:
  PROJECT_NAME: ${config.projectName}
  REGISTRY_USER: ${config.registryUser}
  BASE_DOMAIN: ${config.domain}
  MAIN_NAMESPACE: ${config.projectName}-production
  PR_NAMESPACE: ${config.projectName}-pr-\${{ github.event.pull_request.number }}
  PR_ENV_NAME: pr-\${{ github.event.pull_request.number }}
  PR_DOMAIN: pr-\${{ github.event.pull_request.number }}.${config.domain}
\${envsBlock ? envsBlock + '\\n' : ''}\${registryEnv ? '  ' + registryEnv + '\\n' : ''}

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

      - name: Fetch Kubeconfig from EC2
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa
          
          # Retrieve EC2 IP using Terraform or from secrets if exported
          export EC2_IP=\${{ secrets.EC2_IP }}
          if [ -z "$EC2_IP" ]; then
            echo "::error::EC2_IP secret is missing. Please ensure Terraform exports EC2_IP or set it as a Repository Secret."
            exit 1
          fi
          
          mkdir -p ~/.kube
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
          chmod 600 ~/.kube/config
          
          sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-west-2

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3

      - name: Verify Cluster Resources & Autoscale
        env:\${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \\\${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \\\${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          echo "Checking available resources on Kubernetes cluster..."
          
          CAPACITY_KI=$(kubectl get nodes -o jsonpath='{.items[*].status.capacity.memory}' | sed 's/Ki//g' | awk '{sum=0; for(i=1; i<=NF; i++) sum+=$i; print sum}')
          ALLOCATABLE_KI=$(kubectl get nodes -o jsonpath='{.items[*].status.allocatable.memory}' | sed 's/Ki//g' | awk '{sum=0; for(i=1; i<=NF; i++) sum+=$i; print sum}')
          
          echo "Total Capacity: \${CAPACITY_KI} Ki"
          echo "Allocatable (after k3s/system reservation): \${ALLOCATABLE_KI} Ki"
          
          BUFFER_KI=$((CAPACITY_KI * 20 / 100))
          echo "20% Safety Buffer: \${BUFFER_KI} Ki"
          
          AVAILABLE_KI=$((ALLOCATABLE_KI - BUFFER_KI))
          
          # Approximate memory required for a PR capsule (API + Frontend + DB requests)
          # API: ~256Mi, Frontend: ~128Mi, DB: ~256Mi -> Total ~640Mi = 655360Ki
          REQUIRED_KI=655360
          
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
            
            export EC2_IP=\${{ secrets.EC2_IP }}
            ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "kubectl wait --for=condition=Ready node --all --timeout=120s"
          else
            echo "Sufficient resources available. Proceeding with deployment."
          fi

      - name: Setup Werf
        uses: werf/actions/install@v2
${loginStep}
      - name: Deploy application with Werf
        run: |
          werf converge \\
            --parallel-tasks-limit=3 \\
            --repo ${repoString} \\
            --env \${{ env.PR_ENV_NAME }} \\
            --set ingress.domain=\${{ env.PR_DOMAIN }} \\
${setEnvs}            --set database.password=\${{ secrets.${config.dbPasswordKey} }}${loginRegistryHost === 'docker.io' ? '' : `

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

      - name: Fetch Kubeconfig from EC2
        run: |
          mkdir -p ~/.ssh
          echo "\${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa
          
          export EC2_IP=\${{ secrets.EC2_IP }}
          if [ -z "$EC2_IP" ]; then
            echo "::error::EC2_IP secret is missing. Cannot proceed with cleanup."
            exit 1
          fi
          
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
        env:\${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \\\${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \\\${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          export EC2_IP=\${{ secrets.EC2_IP }}
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "bash -s" << 'EOF'
            CURRENT_WORKERS=$(kubectl get nodes -l node-role.kubernetes.io/master!=true --no-headers 2>/dev/null | wc -l || echo "0")
            if [ "$CURRENT_WORKERS" -eq 0 ]; then
              echo "No worker nodes to scale down."
              echo "SCALE_DOWN=false" > /tmp/scale_down.env
              exit 0
            fi
            
            NODE_NAME="${config.projectName}-instance-worker-$CURRENT_WORKERS"
            echo "Checking if node $NODE_NAME is idle..."
            
            # Count pods on this node excluding kube-system
            PODS=$(kubectl get pods --field-selector spec.nodeName=$NODE_NAME --all-namespaces --no-headers 2>/dev/null | grep -v "kube-system" | wc -l || echo "0")
            
            if [ "$PODS" -eq 0 ]; then
              echo "Node $NODE_NAME is idle! Draining..."
              kubectl drain $NODE_NAME --ignore-daemonsets --delete-emptydir-data --force || true
              kubectl delete node $NODE_NAME || true
              echo "Node $NODE_NAME successfully removed from K3s."
              echo "SCALE_DOWN=true" > /tmp/scale_down.env
              echo "NEW_WORKERS=$((CURRENT_WORKERS - 1))" >> /tmp/scale_down.env
            else
              echo "Node $NODE_NAME has $PODS active pods. Skipping scale down."
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
\`;
};
