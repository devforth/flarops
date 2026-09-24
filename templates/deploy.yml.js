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
        uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3
        with:
          registry: ${loginRegistryHost}
          username: \${{ env.REGISTRY_USER }}
          password: \${{ secrets.REGISTRY_PASSWORD }}
`;

  // Secrets are passed through a step-level `env:` block (GitHub Actions writes these
  // directly into the runner's process environment - no shell interpolation happens)
  // and then serialized into a Helm values file by Python's json encoder, which
  // properly escapes quotes/backticks/newlines. This replaces the previous
  // `--set env.K=${{ secrets.K }}` pattern, which placed secret values directly inside
  // a `run:` shell string: a secret containing backticks or `$(...)` would execute
  // arbitrary commands on the runner (which holds AWS keys, the SSH deploy key and
  // kubeconfig at that point).
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

  // Only reference a DB password secret when this project actually has one -
  // otherwise every project (with or without a database) ends up pointing CI at
  // a repository secret ("DATABASE_PASSWORD") that was never asked for and
  // doesn't exist.
  const dbPasswordEnvLine = config.hasDbPassword ? `          SECRET_DB_PASSWORD: \${{ secrets.${config.dbPasswordKey} }}\n` : '';

  return `name: Flarops CI/CD Pipeline

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

# Terraform state has one lock, but nothing stopped two pushes to main from
# racing for it and failing half-applied. Serialize instead of cancelling, so
# an in-flight apply is always allowed to finish.
concurrency:
  group: flarops-deploy-${config.projectName}
  cancel-in-progress: false

env:
  AWS_REGION: ${config.awsRegion || 'us-west-2'}
  PROJECT_NAME: ${config.projectName}
  REGISTRY_USER: ${config.registryUser}
  BASE_DOMAIN: ${config.domain}
${registryEnv ? '  ' + registryEnv : ''}

jobs:
  infrastructure:
    name: Provision Infrastructure & Deploy
    runs-on: ubuntu-latest
    # Neither job has a natural bound - the k3s wait below and the werf
    # converge can both stall indefinitely - and GitHub's own limit is six
    # hours, during which the concurrency group keeps every later push queued.
    timeout-minutes: 45
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

      - name: Terraform Apply
        working-directory: deploy/terraform
        env:${config.hasCloudflare ? `
          TF_VAR_cloudflare_api_token: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          TF_VAR_cloudflare_zone_id: \${{ secrets.CLOUDFLARE_ZONE_ID }}` : ''}
          TF_VAR_domain: \${{ env.BASE_DOMAIN }}
        run: |
          # Workers must survive this apply untouched: they are added and
          # removed by the PR-capsule workflow, and this one only owns the
          # server. Read the slots Terraform itself reports rather than
          # grepping its state listing - a transient backend error there used
          # to read as "zero workers", and the apply would then DESTROY every
          # worker node.
          #
          # Read ALL outputs in one go rather than asking for worker_slots by
          # name. On a cold deploy nothing has been applied yet, so that output
          # does not exist and "terraform output -json worker_slots" exits 1 -
          # which this guard then treated as a broken backend and refused to
          # create the infrastructure at all. Asking for every output returns
          # "{}" and exit 0 on an empty state, so a real read failure stays
          # distinguishable from simply having nothing yet.
          set -o pipefail
          if ! ALL_OUTPUTS=$(terraform output -json 2>&1); then
            echo "::error::Could not read Terraform outputs, refusing to apply: $ALL_OUTPUTS"
            exit 1
          fi
          CURRENT_SLOTS=$(printf '%s' "$ALL_OUTPUTS" | python3 -c "import json,sys; v=json.load(sys.stdin).get('worker_slots',{}).get('value',[]); print(json.dumps(v if isinstance(v,list) else []))")
          echo "Preserving existing worker slots: $CURRENT_SLOTS"
          terraform apply -var="worker_slots=$CURRENT_SLOTS" -auto-approve -lock-timeout=5m

      - name: Setup SSH
        uses: webfactory/ssh-agent@dc588b651fe13675774614f8e6a936a468676387 # v0.9.0
        with:
          ssh-private-key: \${{ secrets.SSH_PRIVATE_KEY }}

      - name: Fetch Kubeconfig from EC2
        working-directory: deploy/terraform
        run: |
          export EC2_IP=$(terraform output -raw public_ip)

          echo "Waiting for K3s to be ready on $EC2_IP..."
          # Bounded. An unbounded loop here waited out GitHub's six-hour job
          # limit whenever k3s failed to install (bad AMI, apt or network
          # trouble in user_data), with the EC2 instance already created and
          # billing and every later push queued behind it.
          for attempt in $(seq 1 60); do
            if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$EC2_IP "sudo test -f /etc/rancher/k3s/k3s.yaml"; then
              break
            fi
            if [ "$attempt" -eq 60 ]; then
              echo "::error::k3s did not finish installing within 10 minutes. Check cloud-init on the server ($EC2_IP): /var/log/cloud-init-output.log"
              exit 1
            fi
            echo "Waiting for k3s.yaml... ($attempt/60)"
            sleep 10
          done

          mkdir -p ~/.kube
          ssh -o StrictHostKeyChecking=no ubuntu@$EC2_IP "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
          chmod 600 ~/.kube/config

          sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config

      - name: Setup Werf
        uses: werf/actions/install@49e2d1cf7fcda661767ee6d8205f3fb4687e684d # branch v2 @ 2026-05-21
${loginStep}
      - name: Verify Kubeconfig
        run: |
          kubectl get nodes

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
            --env production \\
            --values deploy/helm/flarops-ci-values.json${loginRegistryHost === 'docker.io' ? '' : `

      - name: Cleanup old images
        run: |
          werf cleanup \\
            --repo ${repoString}`}
`;
}
