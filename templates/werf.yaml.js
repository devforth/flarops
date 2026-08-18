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
  return yaml;
};
