// Which Helm templates a config produces. init and sync both render from here.

const path = require('path');

const ingressTemplate = require('./01-ingress.js');
const secretTemplate = require('./secret.js');
const registrySecretTemplate = require('./registry-secret.js');
const helpersTemplate = require('./helpers.tpl.js');
const dashboardYamlTemplate = require('./dashboard.yaml.js');
const apiServiceTemplate = require('./api/service.js');
const apiDeploymentTemplate = require('./api/deployment.js');
const frontendServiceTemplate = require('./frontend/service.js');
const frontendDeploymentTemplate = require('./frontend/deployment.js');
const dbServiceTemplate = require('./database/service.js');
const dbDeploymentTemplate = require('./database/deployment.js');
const genericServiceTemplate = require('./generic/service.js');
const genericDeploymentTemplate = require('./generic/deployment.js');
const genericDatabaseTemplate = require('./generic/database.js');
const supportServiceTemplate = require('./generic/support.js');
const jobTemplate = require('./generic/job.js');

// Keys spliced into a URL get a percent-encoded twin in the Secret.
function urlEncodedSecretKeys(config) {
  const keys = new Set();
  if (config.dbPasswordKey && (config.dbUrlVars || []).length > 0) keys.add(config.dbPasswordKey);
  for (const service of config.additionalServices || []) {
    if (service.db && service.db.passwordKey && (service.dbUrlVars || []).length > 0) keys.add(service.db.passwordKey);
  }
  return [...keys];
}

// Two parts of the chart written to one file: the later one would silently replace the earlier.
class ChartConflict extends Error {}

function renderChartTemplates(config, templatesDir) {
  const at = (name) => path.join(templatesDir, name);
  const files = [
    { file: at('01-ingress.yaml'), content: ingressTemplate(config) },
    { file: at('_helpers.tpl'), content: helpersTemplate() },
    { file: at('secret.yaml'), content: secretTemplate(urlEncodedSecretKeys(config)) },
    { file: at('registry-secret.yaml'), content: registrySecretTemplate(config) },
    { file: at('dashboard.yaml'), content: dashboardYamlTemplate(config) },
  ];

  if (config.hasBackend) {
    files.push({ file: at('api.yaml'), content: apiServiceTemplate() + '\n---\n' + apiDeploymentTemplate(config) });
  }
  if (config.hasFrontend) {
    files.push({ file: at('frontend.yaml'), content: frontendServiceTemplate() + '\n---\n' + frontendDeploymentTemplate(config) });
  }

  const supportRef = (s) => `(index .Values.supportServices (index .Values.supportServicesIndices "${s.name}" | int))`;
  const additionalRef = (s) => `(index .Values.additionalServices (index .Values.additionalServicesIndices "${s.name}" | int))`;

  for (const s of config.supportServices || []) {
    files.push(s.oneShot
      ? { file: at(`support-${s.name}.yaml`), content: jobTemplate(s, { valuesRef: supportRef(s) }) }
      : { file: at(`support-${s.name}.yaml`), content: supportServiceTemplate(s) });
  }

  for (const s of config.additionalServices || []) {
    if (s.oneShot) {
      files.push({ file: at(`${s.name}.yaml`), content: jobTemplate(s, { valuesRef: additionalRef(s) }) });
      continue;
    }
    // No ports, no Service.
    const hasPorts = (s.ports || []).length > 0;
    files.push({ file: at(`${s.name}.yaml`), content: (hasPorts ? genericServiceTemplate(s) + '\n---\n' : '') + genericDeploymentTemplate(s) });
    if (s.db && !s.db.shared) {
      files.push({ file: at(`${s.name}-db.yaml`), content: genericDatabaseTemplate(s) });
    }
  }

  if (config.dbType) {
    files.push({ file: at('database.yaml'), content: dbServiceTemplate(config) + '\n---\n' + dbDeploymentTemplate(config) });
  }

  const seen = new Set();
  for (const f of files) {
    const name = path.basename(f.file);
    if (seen.has(name)) {
      throw new ChartConflict(`two parts of the chart would both be written to deploy/helm/templates/${name} - rename the service whose name produces it`);
    }
    seen.add(name);
  }
  return files;
}

module.exports = { renderChartTemplates, ChartConflict };
