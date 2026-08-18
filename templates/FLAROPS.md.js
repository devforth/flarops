module.exports = function flaropsMdTemplate() {
  return `# Flarops Deployment Guide

Flarops has successfully generated the infrastructure and CI/CD configuration for your project!

## Next Manual Steps

To complete the setup and perform your first deployment, please follow these instructions:

### 1. Add GitHub Secrets
You must manually add the generated secrets to your GitHub repository. 
1. Go to your GitHub repository.
2. Navigate to **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.
3. Open the generated \`deploy/.env\` file in your project.
4. For each variable in that file, create a new Repository Secret with the exact same name (e.g., \`AWS_ACCESS_KEY_ID\`) and its corresponding value.
*(Note: Be sure to copy multiline secrets like \`SSH_PRIVATE_KEY\` exactly as they are, including line breaks, without any surrounding quotation marks).*

### 2. Push to your Branch
Commit the newly generated files to your repository. Flarops has automatically updated your \`.gitignore\` to exclude sensitive files like \`.env\` and your local \`.keys/\` directory.

\`\`\`bash
git add .
git commit -m "chore: setup Flarops CI/CD and infrastructure"
git push origin main
\`\`\`

Once you push to the \`main\` branch (or trigger it manually), the GitHub Actions workflow (\`deploy.yml\`) will automatically start provisioning your infrastructure and deploying your application.
`;
};
