module.exports = function werfYmlTemplate(config) {
  let yaml = `project: ${config.projectName}
configVersion: 1
deploy:
  helmChartDir: deploy/helm
`;
  if (config.backendPath) {
    yaml += `---
image: api
dockerfile: ${config.apiDockerfile}
context: ${config.backendPath === '.' ? '.' : config.backendPath}
`;
  }
  if (config.frontendPath) {
    yaml += `---
image: frontend
dockerfile: ${config.frontendDockerfile}
context: ${config.frontendPath}
`;
  }
  if (config.dbHasLocalDockerfile) {
    yaml += `---
image: db
dockerfile: ${config.dbLocalDockerfile}
context: ${config.dbContext === '.' ? '.' : config.dbContext}
`;
  }
  
  if (config.additionalServices && config.additionalServices.length > 0) {
    for (const s of config.additionalServices) {
      yaml += `---
image: ${s.name}
dockerfile: ${s.dockerfile || 'Dockerfile'}
context: ${s.relativePath === '.' ? '.' : s.relativePath}
`;
    }
  }

  yaml += `---
image: dashboard
dockerfile: Dockerfile
context: deploy/dashboard
`;
  return yaml;
};
