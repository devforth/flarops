// One PersistentVolumeClaim per declared volume. The size is written into the claim, not values.yaml:
// a bound PVC cannot be shrunk. Helm keeps the claim when the volume leaves flarops.yaml, so removing
// a line never deletes data.
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
  annotations:
    "helm.sh/resource-policy": keep
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
${mountPad}  mountPath: {{ ${JSON.stringify(String(v.target))} | quote }}`;
    volumes += `
${volumePad}- name: ${claimName}
${volumePad}  persistentVolumeClaim:
${volumePad}    claimName: ${claimName}`;
  }

  return { pvcs, volumeMounts, volumes };
}

// A StatefulSet's volumes: one claim template per volume (Kubernetes names the claims
// <volume>-<statefulset>-<ordinal> and keeps them when the StatefulSet goes) and its mounts.
function renderStatefulVolumes(volumes, { mountIndent = 12 } = {}) {
  const pad = ' '.repeat(mountIndent);
  let mounts = '';
  let claimTemplates = '';
  for (const v of volumes) {
    const name = String(v.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    mounts += `
${pad}- name: ${name}
${pad}  mountPath: {{ ${JSON.stringify(String(v.target))} | quote }}`;
    claimTemplates += `
    - metadata:
        name: ${name}
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: "${String(v.size || DEFAULT_SIZE).replace(/"/g, '')}"`;
  }
  return { mounts, claimTemplates };
}

module.exports = { renderVolumes, renderStatefulVolumes, claimNameFor, DEFAULT_SIZE };
