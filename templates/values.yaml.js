// Renders deploy/helm/values.yaml; init and sync both use it.

const { yamlEscapeDoubleQuoted, generateEnvString } = require('../utils/yamlWrite.js');
const { normalizeRoutes } = require('../utils/routes.js');

const renderRoutes = (list, indent) => {
  const routes = normalizeRoutes(list);
  if (routes.length === 0) return `${' '.repeat(indent)}[]`;
  return routes.map(r => `${' '.repeat(indent)}- path: "${yamlEscapeDoubleQuoted(r.path)}"${r.stripPrefix ? `\n${' '.repeat(indent + 2)}stripPrefix: true` : ''}`).join('\n');
};

module.exports = function renderValues(config, context) {
  let additionalServicesYaml = '';
  if (config.additionalServices && config.additionalServices.length > 0) {
    additionalServicesYaml = 'additionalServices:\n';
    for (const s of config.additionalServices) {
      additionalServicesYaml += `  - name: ${s.name}
    image: ${s.name}:latest
    env:
${generateEnvString(s.env, context, '      ')}
    secretKeys:
${s.secretKeys.map(k => '      - ' + k).join('\n')}
    ports:${s.ports.length === 0 ? ' []' : '\n' + s.ports.map(p => '      - ' + p).join('\n')}
    replicas: ${s.replicas ?? 1}
    healthRoute: ${s.healthRoute ? '"' + yamlEscapeDoubleQuoted(s.healthRoute) + '"' : 'null'}
    healthPort: ${s.healthPort || 'null'}
    exposedRoutes:
${renderRoutes(s.exposedRoutes, 6)}
    # false when this project's own API gateway already covers these routes -
    # set to true to also expose them directly, bypassing the gateway.
    exposeDirectly: ${s.suppressDirectIngress ? 'false' : 'true'}
${s.command ? `    command:\n${s.command.map(a => '      - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}${(s.db && !s.db.shared) ? `    db:
      type: "${yamlEscapeDoubleQuoted(s.db.type)}"
      image: "${yamlEscapeDoubleQuoted(s.db.image)}"
      port: ${s.db.port}
      user: "${yamlEscapeDoubleQuoted(s.db.user)}"
      name: "${yamlEscapeDoubleQuoted(s.db.name)}"
      replicas: ${s.db.replicas ?? 1}
      storage: "10Gi"
${s.db.command ? `      command:\n${s.db.command.map(a => '        - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}` : ''}`;
    }
  }

  let supportServicesYaml = '';
  if (config.supportServices && config.supportServices.length > 0) {
    supportServicesYaml = '\n# Third-party components declared in docker-compose that the application\n' +
      '# references but this repository does not build. Images are pinned exactly as\n' +
      '# docker-compose declared them.\nsupportServices:\n';
    for (const s of config.supportServices) {
      supportServicesYaml += `  - name: ${s.name}
    image: "${yamlEscapeDoubleQuoted(s.image)}"
    replicas: ${s.replicas ?? 1}
    env:
${generateEnvString(s.env, context, '      ')}
    secretKeys:
${(s.secretKeys || []).map(k => '      - ' + k).join('\n')}
    ports:
${(s.ports || []).map(p => '      - ' + p).join('\n')}
${(s.volumes && s.volumes.length > 0) ? `    storage: "5Gi"\n` : ''}${s.command ? `    command:\n${s.command.map(a => '      - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}`;
    }
    supportServicesYaml += 'supportServicesIndices:\n';
    for (let i = 0; i < config.supportServices.length; i++) {
      supportServicesYaml += `  ${config.supportServices[i].name}: ${i}\n`;
    }
  }

  let valuesYaml = `projectName: ${config.projectName}
domain: "${yamlEscapeDoubleQuoted(config.domain)}"
hasBackend: ${config.hasBackend}
hasFrontend: ${config.hasFrontend}
apiServesFrontend: ${!!config.apiServesFrontend}
images:
${config.hasBackend ? `  api: ${config.images.api}` : ''}
  db: ${config.images.db ? '"' + yamlEscapeDoubleQuoted(config.images.db) + '"' : 'null'}
${config.hasFrontend ? `  frontend: ${config.images.frontend}` : ''}
dbCloneSource: "${yamlEscapeDoubleQuoted(config.dbCloneSource)}"
dbType: ${config.dbType ? '"' + config.dbType + '"' : 'null'}
dbPort: ${config.dbPort || 'null'}
database:
  user: "${yamlEscapeDoubleQuoted(config.dbUser)}"
  password: null
  name: "${yamlEscapeDoubleQuoted(config.dbName)}"
  replicas: ${config.dbReplicas ?? 1}
  storage: "${yamlEscapeDoubleQuoted(config.dbStorage || '10Gi')}"
${config.dbCommand ? `  command:\n${config.dbCommand.map(a => '    - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}  env:
    # KEY: "VALUE"
${config.hasBackend ? `api:
  replicas: ${config.apiReplicas ?? 1}
  healthRoute: ${config.apiHealthRoute ? '"' + yamlEscapeDoubleQuoted(config.apiHealthRoute) + '"' : 'null'}
  healthPort: ${config.apiHealthPort || 'null'}
  secretKeys:
${config.apiSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${generateEnvString(config.apiEnv || {}, context)}
${config.apiCommand ? `  command:\n${config.apiCommand.map(a => '    - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}apiPorts:
${config.apiPorts.map(p => '  - ' + p).join('\n')}` : ''}
${config.hasFrontend ? `frontend:
  replicas: ${config.frontendReplicas ?? 1}
  secretKeys:
${config.frontendSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${generateEnvString(config.frontendEnv || {}, context)}
${config.frontendCommand ? `  command:\n${config.frontendCommand.map(a => '    - "' + yamlEscapeDoubleQuoted(a) + '"').join('\n')}\n` : ''}frontendPorts:
${config.frontendPorts.map(p => '  - ' + p).join('\n')}` : ''}
${additionalServicesYaml}${supportServicesYaml}
apiRoutes:
${renderRoutes(config.apiRoutes, 2)}

# instanceType and volumeSize are filled in by CI from Terraform's outputs -
# change them in deploy/terraform/variables.tf, not here.
aws:
  region: "${yamlEscapeDoubleQuoted(config.awsRegion)}"
  instanceType: null
  volumeSize: null
dashboard:
  replicas: 1
  storage: "1Gi"
# Filled in by CI from the registry credentials. Leave null: nothing secret
# belongs in this committed file.
imagePullSecret: null
# Set by the PR-capsule workflow to the node a capsule is placed on. Leave
# empty here.
dataNodeSelector: {}
`;

  if (config.additionalServices && config.additionalServices.length > 0) {
    valuesYaml += 'additionalServicesIndices:\n';
    for (let i = 0; i < config.additionalServices.length; i++) {
      valuesYaml += `  ${config.additionalServices[i].name}: ${i}\n`;
    }
  }

  return valuesYaml;
};
