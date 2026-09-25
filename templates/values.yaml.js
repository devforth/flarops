// Renders deploy/helm/values.yaml.
//
// Extracted so `flarops sync` emits exactly what `flarops init` does. These
// are the knobs an operator turns without regenerating anything, and a second
// copy of this emitter would have meant a service declared by hand in
// flarops.yaml quietly acquiring a different shape from one init discovered -
// which is the very thing sync exists to prevent.
//
// `context` is mutated: generateEnvString sets hasLocalhostWarnings on it when
// any value still points at localhost, and the caller reports that once.

const { yamlEscapeDoubleQuoted, generateEnvString } = require('../utils/yamlWrite.js');
const { normalizeRoutes } = require('../utils/routes.js');

// Routes are written as objects so a transformation can travel with the path.
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
    ports:
${s.ports.map(p => '      - ' + p).join('\n')}
    replicas: ${s.replicas || 1}
    healthRoute: ${s.healthRoute ? '"' + s.healthRoute + '"' : 'null'}
    healthPort: ${s.healthPort || 'null'}
    exposedRoutes:
${renderRoutes(s.exposedRoutes, 6)}
    # false when this project's own API gateway already covers these routes
    # (see detectServiceIsGateway) - set to true to also expose them directly,
    # bypassing the gateway.
    exposeDirectly: ${s.suppressDirectIngress ? 'false' : 'true'}
${s.command ? `    command:\n${s.command.map(a => '      - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}${(s.db && !s.db.shared) ? `    db:
      type: "${yamlEscapeDoubleQuoted(s.db.type)}"
      image: "${yamlEscapeDoubleQuoted(s.db.image)}"
      port: ${s.db.port}
      user: "${yamlEscapeDoubleQuoted(s.db.user)}"
      name: "${yamlEscapeDoubleQuoted(s.db.name)}"
      replicas: ${s.db.replicas || 1}
      storage: "10Gi"
` : ''}`;
    }
  }

  // Supporting services (see utils/composeSupport.js) carry a literal image
  // from docker-compose rather than one werf builds, so the image belongs in
  // values.yaml where it can be re-pinned without regenerating anything.
  let supportServicesYaml = '';
  if (config.supportServices && config.supportServices.length > 0) {
    supportServicesYaml = '\n# Third-party components declared in docker-compose that the application\n' +
      '# references but this repository does not build. Images are pinned exactly as\n' +
      '# docker-compose declared them.\nsupportServices:\n';
    for (const s of config.supportServices) {
      supportServicesYaml += `  - name: ${s.name}
    image: "${yamlEscapeDoubleQuoted(s.image)}"
    replicas: ${s.replicas || 1}
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
domain: "${config.domain}"
hasBackend: ${config.hasBackend}
hasFrontend: ${config.hasFrontend}
apiServesFrontend: ${!!config.apiServesFrontend}
images:
${config.hasBackend ? `  api: ${config.images.api}` : ''}
  db: ${config.images.db}
${config.hasFrontend ? `  frontend: ${config.images.frontend}` : ''}
dbCloneSource: "${config.dbCloneSource}"
dbType: ${config.dbType ? '"' + config.dbType + '"' : 'null'}
dbPort: ${config.dbPort || 'null'}
database:
  user: "${yamlEscapeDoubleQuoted(config.dbUser)}"
  password: null
  name: "${yamlEscapeDoubleQuoted(config.dbName)}"
  replicas: ${config.dbReplicas || 1}
  storage: "${yamlEscapeDoubleQuoted(config.dbStorage || '10Gi')}"
  env:
    # KEY: "VALUE"
${config.hasBackend ? `api:
  replicas: ${config.apiReplicas || 1}
  healthRoute: ${config.apiHealthRoute ? '"' + config.apiHealthRoute + '"' : 'null'}
  healthPort: ${config.apiHealthPort || 'null'}
  secretKeys:
${config.apiSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${generateEnvString(config.apiEnv || {}, context)}
${config.apiCommand ? `  command:\n${config.apiCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}apiPorts:
${config.apiPorts.map(p => '  - ' + p).join('\n')}` : ''}
${config.hasFrontend ? `frontend:
  replicas: ${config.frontendReplicas || 1}
  secretKeys:
${config.frontendSecretKeys.map(k => '    - ' + k).join('\n')}
  env:
${generateEnvString(config.frontendEnv || {}, context)}
${config.frontendCommand ? `  command:\n${config.frontendCommand.map(a => '    - "' + String(a).replace(/"/g, '\\"') + '"').join('\n')}\n` : ''}frontendPorts:
${config.frontendPorts.map(p => '  - ' + p).join('\n')}` : ''}
${additionalServicesYaml}${supportServicesYaml}
apiRoutes:
${renderRoutes(config.apiRoutes, 2)}

# instanceType and volumeSize are deliberately NOT set here. They are declared
# once, in deploy/terraform/variables.tf, and CI reads them back out of
# Terraform's outputs into these keys at deploy time (see the workflow's
# buildValuesScript). Writing them here as well would mean three copies of the
# same fact - chart, Terraform and dashboard - that drift the first time
# someone resizes the fleet and only edits one of them.
#
# region is the exception: Terraform cannot be its source, because the region
# has to be known before Terraform can initialise its own S3 backend.
aws:
  region: "${yamlEscapeDoubleQuoted(config.awsRegion)}"
  instanceType: null
  volumeSize: null
dashboard:
  replicas: 1
  storage: "1Gi"
# Populated by CI from the registry credentials (see the workflow's
# buildValuesScript) so private images can be pulled. Left null here on
# purpose - nothing secret belongs in a committed file.
imagePullSecret: null
# Set by the PR-capsule workflow to the node the dashboard's capacity oracle
# picked. Only the STATEFUL workloads read it: their volumes come from k3s's
# local-path provisioner and live on one node's disk, so a database pod that
# moves can never reach its data again. Stateless workloads are deliberately
# left to the scheduler, so a capsule can use room spread across the fleet.
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
