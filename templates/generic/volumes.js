// One PersistentVolumeClaim per declared volume. The size is written into the claim, not values.yaml:
// a bound PVC cannot be shrunk.
const DEFAULT_SIZE = '5Gi';

function claimNameFor(serviceName, volumeName) {
  return `${serviceName}-${volumeName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

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
