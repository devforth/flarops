// werf.yaml is itself a Go template: a value is written as a quoted YAML string whose "{{" is
// printed, not evaluated.
function werfString(value) {
  const yaml = String(value)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return `"${yaml.replace(/\{\{/g, '{{ "{{" }}')}"`;
}

// build.args reach the image build only through werf.
function renderBuildArgs(args) {
  if (!args || Object.keys(args).length === 0) return '';
  let out = 'args:\n';
  for (const [key, value] of Object.entries(args)) {
    out += `  ${key}: ${werfString(value)}\n`;
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
dockerfile: ${werfString(config.apiDockerfile)}
context: ${werfString(config.backendPath)}
${renderBuildArgs(config.apiBuildArgs)}`;
  }
  if (config.frontendPath) {
    yaml += `---
image: frontend
dockerfile: ${werfString(config.frontendDockerfile)}
context: ${werfString(config.frontendPath)}
${renderBuildArgs(config.frontendBuildArgs)}`;
  }
  if (config.dbHasLocalDockerfile) {
    yaml += `---
image: db
dockerfile: ${werfString(config.dbLocalDockerfile)}
context: ${werfString(config.dbContext || '.')}
`;
  }
  
  if (config.additionalServices && config.additionalServices.length > 0) {
    for (const s of config.additionalServices) {
      // A Maven reactor module builds from the repo root (its pom inherits ../pom.xml).
      const context = s.isMavenReactorModule
        ? '.'
        : (s.relativePath && s.relativePath !== '.' ? s.relativePath : '.');
      const dockerfilePath = s.isMavenReactorModule
        ? `${s.relativePath}/${s.dockerfile || 'Dockerfile'}`
        : (s.dockerfile || 'Dockerfile');

      yaml += `---
image: ${s.name}
dockerfile: ${werfString(dockerfilePath)}
context: ${werfString(context)}
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
