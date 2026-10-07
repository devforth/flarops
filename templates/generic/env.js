// Env list pieces every workload template renders the same way.

function secretRefs(mappings, root = '$.') {
  let out = '';
  for (const mapping of mappings || []) {
    out += `
            - name: ${mapping.envName}
              valueFrom:
                secretKeyRef:
                  name: {{ ${root}Values.projectName }}-secrets
                  key: ${mapping.secretKey}`;
  }
  return out;
}

// The encoded twin must come before the URLs: $(VAR) expands only against earlier entries.
function urlEncodedRef(key, root = '$.') {
  if (!key) return '';
  return `
            - name: ${key}_URLENCODED
              valueFrom:
                secretKeyRef:
                  name: {{ ${root}Values.projectName }}-secrets
                  key: ${key}_URLENCODED`;
}

// Whether `key` is already in this container's env list; Kubernetes rejects duplicates.
function alreadyEmitted(secretKeys, mappings, key) {
  if (!key) return false;
  return (Array.isArray(secretKeys) && secretKeys.includes(key))
    || (mappings || []).some(m => m.envName === key);
}

// Text Helm must print as it is, never evaluate: a Go string literal piped through quote.
function helmLiteral(value) {
  return `{{ ${JSON.stringify(String(value))} | quote }}`;
}

// Encodes values known at generation time; the password is encoded in the Secret (flarops.urlencode).
const urlComponent = (value) => encodeURIComponent(String(value === undefined || value === null ? '' : value));

// The database env a built service's container gets: its password, Spring's, and the URLs the chart
// builds. Shared by the Deployment and the one-shot Job.
function databaseEnv(service) {
  const { dbUrlScheme } = require('../../utils/dbDefaults.js');
  // Skip the DB password block when the same env name is already emitted - duplicates are rejected.
  const dbPasswordAlreadyEmitted = alreadyEmitted(service.secretKeys, service.extraSecretEnvMappings, service.dbPasswordKey);
  let block = (service.dbPasswordKey && !dbPasswordAlreadyEmitted) ? `
            - name: ${service.dbPasswordKey}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.dbPasswordKey}` : '';

  if (service.springDatasourcePasswordSecretKey) {
    block += `
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.springDatasourcePasswordSecretKey}`;
  }

  if (service.db && Array.isArray(service.dbUrlVars) && service.dbUrlVars.length > 0) {
    const db = service.db;
    const dbHost = db.shared ? 'database' : `${service.name}-db`;
    const authSuffix = db.type === 'mongodb' ? '?authSource=admin' : '';
    // The encoded twin must come before the URLs: $(VAR) expands only against earlier entries.
    if (db.passwordKey) block += urlEncodedRef(db.passwordKey);
    for (const urlVar of service.dbUrlVars) {
      const dbName = urlVar.dbName || db.name;
      const dbPath = dbName ? urlComponent(dbName) : '{{ include "flarops.urlencode" $.Values.database.name }}';
      block += `
            - name: ${urlVar.key}
              value: "${dbUrlScheme(db.type, urlVar.scheme)}://${urlComponent(db.user)}:$(${db.passwordKey}_URLENCODED)@${dbHost}:${db.port}/${dbPath}${authSuffix}"`;
    }
  }

  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const keys = [service.dbPasswordKey, service.springDatasourcePasswordSecretKey].filter(Boolean);
  return { block, keys };
}

module.exports = { secretRefs, urlEncodedRef, alreadyEmitted, helmLiteral, databaseEnv };
