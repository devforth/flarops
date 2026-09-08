module.exports = function deployYmlTemplate(config) {
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
          password: \${{ secrets.REGISTRY_PASSWORD }}
`;

  const setEnvs = config.envKeysToPass && config.envKeysToPass.length > 0
    ? config.envKeysToPass.map(k => `            --set env.${k}=\${{ secrets.${k} }}`).join(' \\\n') + ' \\\n'
    : '';

  return `name: Flarops CI/CD Pipeline

on:
  push:
    branches:
      - main
  workflow_dispatch:

env:
  AWS_REGION: us-west-2
  PROJECT_NAME: ${config.projectName}
  REGISTRY_USER: ${config.registryUser}
  BASE_DOMAIN: ${config.domain}
${registryEnv ? '  ' + registryEnv : ''}

jobs:
  infrastructure:
    name: Provision Infrastructure (Terraform)
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

      - name: Terraform Apply
        working-directory: deploy/terraform
        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          CURRENT_WORKERS=$(terraform state list 2>/dev/null | grep 'aws_instance.worker\\[' | wc -l || echo "0")
          echo "Preserving existing $CURRENT_WORKERS worker nodes."
          terraform apply -var="worker_count=$CURRENT_WORKERS" -auto-approve

      - name: Setup SSH
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: \${{ secrets.SSH_PRIVATE_KEY }}
          
      - name: Fetch Kubeconfig from EC2
        working-directory: deploy/terraform
        run: |
          export EC2_IP=$(terraform output -raw public_ip)
          
          echo "Waiting for K3s to be ready on $EC2_IP..."
          until ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo test -f /etc/rancher/k3s/k3s.yaml"; do
            echo "Waiting for k3s.yaml..."
            sleep 10
          done
          
          mkdir -p ~/.kube
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
          chmod 600 ~/.kube/config
          
          sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config

      - name: Setup Werf
        uses: werf/actions/install@v2
${loginStep}
      - name: Verify Kubeconfig
        run: |
          kubectl get nodes

      - name: Deploy application with Werf
        run: |
          werf converge \\
            --parallel-tasks-limit=3 \\
            --repo ${repoString} \\
            --env production \\
${setEnvs}            --set database.password=\${{ secrets.${config.dbPasswordKey} }}${loginRegistryHost === 'docker.io' ? '' : `

      - name: Cleanup old images
        run: |
          werf cleanup \\
            --repo ${repoString}`}
`;
}
