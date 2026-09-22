// docker-compose's build.args are build-time inputs no Kubernetes manifest
// can supply after the fact - werf has to pass them to the Docker build, or
// the image silently compiles with its Dockerfile's ARG defaults.
function renderBuildArgs(args) {
  if (!args || Object.keys(args).length === 0) return '';
  let out = 'args:\n';
  for (const [key, value] of Object.entries(args)) {
    out += `  ${key}: "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
  }
  return out;
}

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
${renderBuildArgs(config.apiBuildArgs)}`;
  }
  if (config.frontendPath) {
    yaml += `---
image: frontend
dockerfile: ${config.frontendDockerfile}
context: ${config.frontendPath}
${renderBuildArgs(config.frontendBuildArgs)}`;
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
      // A Maven reactor module's pom.xml inherits <parent> from the repo-root
      // pom.xml, which Maven resolves via the default "../pom.xml" relative
      // lookup - so it can only be built with the repo root as Docker build
      // context (the module's own directory alone never includes that parent
      // pom), with the Dockerfile path adjusted to be relative to that root.
      const context = s.isMavenReactorModule
        ? '.'
        : (s.relativePath && s.relativePath !== '.' ? s.relativePath : '.');
      const dockerfilePath = s.isMavenReactorModule
        ? `${s.relativePath}/${s.dockerfile || 'Dockerfile'}`
        : (s.dockerfile || 'Dockerfile');

      yaml += `---
image: ${s.name}
dockerfile: ${dockerfilePath}
context: ${context}
${renderBuildArgs(s.buildArgs)}`;
    }
  }

  yaml += `---
image: dashboard
dockerfile: Dockerfile
context: deploy/dashboard
`;
  return yaml;
};
