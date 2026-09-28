// The pieces of a container's env list that every workload template renders
// the same way.
//
// These were written out five times (the secretKeyRef loop), twice (the
// URL-encoded twin) and twice again (the rule deciding whether the database
// password has already been emitted under this name). That last one is not a
// tidiness complaint: it was fixed in templates/api/deployment.js and the fix
// did not reach templates/generic/deployment.js, so the same duplicate-env
// bug had to be found and fixed a second time in the same afternoon.
//
// What is NOT here is the surrounding "env:" scaffolding. It looks alike but
// is not: api and generic/deployment guard their ranges ({{- if X.env }}
// around {{- range }}), support and job default them (($svc.env | default
// dict)), and the two styles emit different whitespace. Unifying those would
// take one parameter per difference, which is the leaky abstraction this
// extraction exists to avoid.
//
// `root` is the Helm scope prefix for .Values: "$." inside a range, "." at the
// top level. It is the only thing that differed between the copies.

// A secretKeyRef entry per mapping, for the keys whose container-side name is
// not the same as the key in the Secret.
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

// The percent-encoded twin of a password, declared before the URLs that splice
// it in: Kubernetes expands "$(VAR)" only against variables already listed
// above it in the same container.
function urlEncodedRef(key, root = '$.') {
  if (!key) return '';
  return `
            - name: ${key}_URLENCODED
              valueFrom:
                secretKeyRef:
                  name: {{ ${root}Values.projectName }}-secrets
                  key: ${key}_URLENCODED`;
}

// Whether `key` is already emitted into this container's env list by another
// mechanism - the generic secretKeys loop, or an explicit mapping whose
// container-side name happens to be this one. Kubernetes rejects a container
// that lists the same env name twice, and `helm template` renders it happily,
// so the duplicate only surfaces at apply time.
function alreadyEmitted(secretKeys, mappings, key) {
  if (!key) return false;
  return (Array.isArray(secretKeys) && secretKeys.includes(key))
    || (mappings || []).some(m => m.envName === key);
}

module.exports = { secretRefs, urlEncodedRef, alreadyEmitted };
