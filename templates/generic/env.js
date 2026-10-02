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

module.exports = { secretRefs, urlEncodedRef, alreadyEmitted };
