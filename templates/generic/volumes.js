// Persistent volumes for a service, as one PersistentVolumeClaim each.
//
// Shared because both kinds of service need them and only one had them: a
// support service (an image this repository pulls) could carry volumes from
// docker-compose, while a service this repository BUILDS had no way to ask for
// storage at all - not from flarops.yaml and not from the chart.
//
// The size is written into the claim rather than read from values.yaml. A
// volume's size is a property of what the service stores, it is declared in
// flarops.yaml beside the path it mounts at, and a PVC cannot be shrunk once
// bound - so keeping it a chart value, editable independently of the
// declaration that explains it, would only invite a change that silently does
// nothing.
const DEFAULT_SIZE = '5Gi';

// A claim name has to be a valid Kubernetes object name, and the service and
// volume names it is built from are whatever the author wrote.
function claimNameFor(serviceName, volumeName) {
  return `${serviceName}-${volumeName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// `indent` is how deep the container's volumeMounts sit in the template that
// calls this - the two templates nest differently.
function renderVolumes(service, { mountIndent = 12, volumeIndent = 8, fallbackSize = null } = {}) {
  const list = Array.isArray(service.volumes) ? service.volumes : [];
  if (list.length === 0) return { pvcs: '', volumeMounts: '', volumes: '' };

  const mountPad = ' '.repeat(mountIndent);
  const volumePad = ' '.repeat(volumeIndent);
  let pvcs = '';
  let volumeMounts = '';
  let volumes = '';

  for (const v of list) {
    const claimName = claimNameFor(service.name, v.name);
    const size = v.size || fallbackSize || DEFAULT_SIZE;
    pvcs += `
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${claimName}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  accessModes: [ "ReadWriteOnce" ]
  resources:
    requests:
      storage: "${String(size).replace(/"/g, '')}"
`;
    volumeMounts += `
${mountPad}- name: ${claimName}
${mountPad}  mountPath: ${v.target}`;
    volumes += `
${volumePad}- name: ${claimName}
${volumePad}  persistentVolumeClaim:
${volumePad}    claimName: ${claimName}`;
  }

  return { pvcs, volumeMounts, volumes };
}

module.exports = { renderVolumes, claimNameFor, DEFAULT_SIZE };
