// FLAROPS.md: the next steps for this project, with its own addresses and branch.
const { dashboardHost, hostParent, prHost, appScheme } = require('../utils/dashboardAccess.js');
const { safeBranch } = require('../utils/branch.js');

module.exports = function flaropsMdTemplate(config = {}) {
  const domain = config.domain || 'example.com';
  const branch = safeBranch(config.deployBranch) || 'main';
  const dashboard = dashboardHost(domain);
  const parent = hostParent(domain);
  const scheme = appScheme(config);

  const dns = config.hasCloudflare
    ? `Cloudflare DNS is managed for you: the first deploy creates \`${domain}\` and a wildcard record pointing at the server.`
    : `Cloudflare was not configured, so create the DNS records yourself once the first deploy has run. The server's IP is in the summary of the "Flarops CI/CD Pipeline" run (repository -> Actions), and in \`terraform -chdir=deploy/terraform output public_ip\` (after \`terraform -chdir=deploy/terraform workspace select main\`: CI keeps its state in the \`main\` workspace). Create A records pointing at it for:

- \`${domain}\`
- \`${dashboard}\`
- \`*.${parent}\` (pull request environments)

HTTPS comes from a proxy in front of the server (Cloudflare's proxy, for example): the server itself serves plain HTTP on port 80.`;

  return `# Deploying ${config.projectName || 'this project'} with Flarops

Flarops has generated the infrastructure and CI/CD for this project. These are the steps to the first deploy.

## 1. Review what init changed

\`\`\`bash
git status
git diff
\`\`\`

Besides the new files, init may have edited your source - its output lists every "refactored" file. Check those changes before you commit.

## 2. Create the GitHub Secrets

Open \`deploy/.env\` (it is git-ignored and never read at deploy time - it is a checklist). In your repository, go to **Settings -> Secrets and variables -> Actions -> New repository secret**, and create one secret per line, with the same name.

Paste each value **without the surrounding quotes**. For \`SSH_PRIVATE_KEY\`, copy everything from \`-----BEGIN\` to the closing \`-----END ... -----\` line, line breaks included.

## 3. Commit and push to \`${branch}\`

\`\`\`bash
git add -A
git commit -m "Deploy with Flarops"
git push origin '${branch}'
\`\`\`

A push to \`${branch}\` runs the "Flarops CI/CD Pipeline" workflow (repository -> Actions). The first run takes about 10-15 minutes. It creates, in your AWS account and billed to it: a VPC, one EC2 instance (\`t3a.medium\`, 40 GB disk) with an Elastic IP in \`${config.awsRegion || 'us-west-2'}\`, and installs k3s, then builds and deploys the application.

## 4. DNS

${dns}

## 5. Open it

- Application: ${scheme}://${domain}
- Dashboard: ${scheme}://${dashboard} - user \`admin\`, with the password init showed once. Lost it? \`npx flarops dashboard-password\` issues a new one.

## Pull requests

Every pull request gets its own environment at \`${scheme}://${prHost(domain, '<number>')}\`, with a copy of the production database. Closing the pull request removes it, and any worker machine it no longer needs.

## Changing the deployment later

Edit \`flarops.yaml\` and run \`npx flarops sync\`, then commit and push. Do not edit \`deploy/helm/\`, \`werf.yaml\` or \`.github/workflows/\` by hand - sync regenerates them. The field reference is the comment block at the end of \`flarops.yaml\`; \`AGENTS.md\` tells coding agents the same.
`;
};
