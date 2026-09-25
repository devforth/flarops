// The one place that decides which Helm templates a given config produces, and
// with what content.
//
// `flarops init` and `flarops sync` both have to answer that question, and
// they have to answer it identically: sync's whole contract is that a service
// declared by hand in flarops.yaml comes out the same as one init discovered
// itself, with only the values the author wrote differing from the defaults.
// Two copies of this list would make that contract untestable the first time
// one of them gained a template the other did not.

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

// The Secret keys that a URL is built from, and which therefore need a
// percent-encoded twin alongside them. Only these: a twin for every secret
// would double the Secret for no reason and put a second copy of values that
// are never spliced into a URL on disk.
function urlEncodedSecretKeys(config) {
  const keys = new Set();
  if (config.dbPasswordKey && (config.dbUrlVars || []).length > 0) keys.add(config.dbPasswordKey);
  for (const service of config.additionalServices || []) {
    // The generic template splices service.db.passwordKey, not the service's
    // own dbPasswordKey - they are different keys when a service talks to a
    // database that is not its own.
    if (service.db && service.db.passwordKey && (service.dbUrlVars || []).length > 0) keys.add(service.db.passwordKey);
  }
  return [...keys];
}

// Returns [{ file, content }] for every template this config implies, with
// `file` resolved under templatesDir.
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

  // A one-shot task gets a Job and nothing else: no Service (it has no
  // endpoints), no probes, no Ingress. Which list it sits in still decides
  // where its values live and whether werf builds it.
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
    files.push({ file: at(`${s.name}.yaml`), content: genericServiceTemplate(s) + '\n---\n' + genericDeploymentTemplate(s) });
    if (s.db && !s.db.shared) {
      files.push({ file: at(`${s.name}-db.yaml`), content: genericDatabaseTemplate(s) });
    }
  }

  if (config.dbType) {
    files.push({ file: at('database.yaml'), content: dbServiceTemplate(config) + '\n---\n' + dbDeploymentTemplate(config) });
  }

  return files;
}

module.exports = { renderChartTemplates };
