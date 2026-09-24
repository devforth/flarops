// Renders a third-party component declared in docker-compose (a cache, a
// broker, an identity provider, ...) that the application's services actually
// reference, as an ordinary Deployment + Service running the same public
// image. See utils/composeSupport.js for why these exist at all.
//
// Two things differ from an additionalService: the image is a literal from
// the compose file rather than something werf builds, and the object is named
// after the compose service so every hostname the application already carries
// resolves without rewriting anything.
module.exports = (service) => {
  const idx = `(index .Values.supportServices (index .Values.supportServicesIndices "${service.name}" | int))`;
  const hasVolumes = Array.isArray(service.volumes) && service.volumes.length > 0;

  // A shared credential (see tryWireSharedCredential in init.js) whose env
  // var name on THIS support service doesn't match the canonical secret key
  // it was generated under - e.g. Keycloak's own KC_DB_PASSWORD referencing
  // the exact password its Postgres support service generated under
  // POSTGRES_PASSWORD. Rendered directly (not through values.yaml), the same
  // way generic/deployment.js does, since the mapping is fixed at generation
  // time, not something an operator would ever hand-edit per environment.
  let extraSecretEnvBlock = '';
  if (Array.isArray(service.extraSecretEnvMappings)) {
    for (const mapping of service.extraSecretEnvMappings) {
      extraSecretEnvBlock += `
            - name: ${mapping.envName}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${mapping.secretKey}`;
    }
  }
  const hasExtraSecretEnv = extraSecretEnvBlock.length > 0;
  // The keys above are rendered straight into the manifest (their container-
  // side names differ from the Secret keys), so they are invisible to the
  // secretKeys list the checksum otherwise reads - name them explicitly or a
  // rotation of one of them would not roll this pod.
  const quoteKeys = (keys) => keys.filter(Boolean).map(k => JSON.stringify(k)).join(' ');
  const extraKeyList = quoteKeys(
    (service.extraSecretEnvMappings || []).map(m => m.secretKey)
  );


  // docker-compose bind mounts that were readable in the repository at
  // generation time (see materializeBindMounts in utils/composeSupport.js).
  // One ConfigMap per service holds them; a file mount lands through subPath
  // so it does not hide the rest of its directory, a directory mount through
  // an items list.
  const configMapName = `${service.name}-config`;
  const hasConfigMap = !!service.configMapData && Object.keys(service.configMapData).length > 0;
  let configMap = '';
  let configVolumeMounts = '';
  let configVolumes = '';
  if (hasConfigMap) {
    configMap = `
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${configMapName}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
data:
`;
    for (const [key, content] of Object.entries(service.configMapData)) {
      // Block scalar: the file is copied verbatim, so it must not be re-parsed
      // as YAML or have anything in it treated as an escape.
      const body = String(content).replace(/\r\n/g, '\n').replace(/\n$/, '')
        .split('\n').map(l => (l === '' ? '' : '    ' + l)).join('\n');
      configMap += `  ${key}: |\n${body}\n`;
    }

    let volIdx = 0;
    for (const mount of service.configFileMounts || []) {
      const volName = `${service.name}-config-${volIdx++}`;
      configVolumeMounts += `
            - name: ${volName}
              mountPath: ${mount.mountPath}
              subPath: ${mount.key}
              readOnly: true`;
      configVolumes += `
        - name: ${volName}
          configMap:
            name: ${configMapName}`;
    }
    for (const mount of service.configDirMounts || []) {
      const volName = `${service.name}-config-${volIdx++}`;
      configVolumeMounts += `
            - name: ${volName}
              mountPath: ${mount.mountPath}
              readOnly: true`;
      configVolumes += `
        - name: ${volName}
          configMap:
            name: ${configMapName}
            items:`;
      for (const item of mount.items) {
        configVolumes += `
              - key: ${item.key}
                path: ${item.path}`;
      }
    }
  }

  let pvcs = '';
  let volumeMounts = '';
  let volumes = '';
  if (hasVolumes) {
    for (const v of service.volumes) {
      const claimName = `${service.name}-${v.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
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
      storage: {{ ${idx}.storage | default "5Gi" }}
`;
      volumeMounts += `
            - name: ${claimName}
              mountPath: ${v.target}`;
      volumes += `
        - name: ${claimName}
          persistentVolumeClaim:
            claimName: ${claimName}`;
    }
  }

  const portsBlock = (service.ports || []).length > 0 ? `
spec:
  selector:
    app: {{ .Values.projectName }}
    component: ${service.name}
  ports:
{{- range $port := ${idx}.ports }}
    - port: {{ $port }}
      targetPort: {{ $port }}
      protocol: TCP
      name: port-{{ $port }}
{{- end }}` : `
spec:
  selector:
    app: {{ .Values.projectName }}
    component: ${service.name}
  ports:
    - port: 80
      targetPort: 80
      protocol: TCP
      name: port-80`;

  return `
apiVersion: v1
kind: Service
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}${portsBlock}
${pvcs}${configMap}---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  replicas: {{ include "flarops.replicas" ${idx}.replicas }}
${hasVolumes ? `  strategy:
    type: Recreate
` : ''}  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: ${service.name}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${service.name}
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (concat (${idx}.secretKeys | default list) (list ${extraKeyList}))) }}${hasConfigMap ? `
        # Rolls the pod when the carried configuration changes. NOT the same
        # mechanism as checksum/secret above: that one is evaluated by Helm at
        # render time, this is a hash computed by the generator, so it only
        # changes when flarops init re-runs. Editing the ConfigMap by hand will
        # not roll the pod.
        checksum/config: ${require('crypto').createHash('sha256').update(JSON.stringify(service.configMapData)).digest('hex').slice(0, 32)}` : ''}
    spec:
      automountServiceAccountToken: false
{{- $svc := ${idx} }}
      containers:
        - name: ${service.name}
          image: {{ $svc.image | quote }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
{{- if $svc.command }}
          args:
{{- range $arg := $svc.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}
{{- if or $svc.env $svc.secretKeys ${hasExtraSecretEnv ? 'true' : 'false'} }}
          env:
{{- range $key, $value := ($svc.env | default dict) }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- range $key := ($svc.secretKeys | default list) }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}${extraSecretEnvBlock}
{{- end }}
{{- if $svc.ports }}
          ports:
{{- range $port := $svc.ports }}
            - containerPort: {{ $port }}
{{- end }}
{{- end }}
          # No resource requests or limits are set here on purpose - see the
          # note in templates/api/deployment.js. A third-party image's real
          # appetite is even less knowable than a first-party service's.
${(volumeMounts || configVolumeMounts) ? `
          volumeMounts:${volumeMounts}${configVolumeMounts}` : ''}${(volumes || configVolumes) ? `
      volumes:${volumes}${configVolumes}` : ''}
`.trim();
};
