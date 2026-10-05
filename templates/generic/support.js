// A supporting service from docker-compose (cache, broker, identity provider): Deployment + Service.
const { renderVolumes } = require('./volumes.js');
const { secretRefs, urlEncodedRef, alreadyEmitted } = require('./env.js');
const { imageHost, isDockerHub } = require('../../utils/registry.js');

module.exports = (service) => {
  const idx = `(index .Values.supportServices (index .Values.supportServicesIndices "${service.name}" | int))`;
  const hasVolumes = Array.isArray(service.volumes) && service.volumes.length > 0;
  const pullsFromPrivateRegistry = !isDockerHub(imageHost(service.image));

  const extraSecretEnvBlock = secretRefs(service.extraSecretEnvMappings);
  const hasExtraSecretEnv = extraSecretEnvBlock.length > 0;
  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const quoteKeys = (keys) => keys.filter(Boolean).map(k => JSON.stringify(k)).join(' ');
  const extraKeyList = quoteKeys(
    (service.extraSecretEnvMappings || []).map(m => m.secretKey)
  );

  // Bind-mounted files, carried as one ConfigMap per service.
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
      // Block scalar: copied verbatim.
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

  const { pvcs, volumeMounts, volumes } = renderVolumes(service, {
    mountIndent: 12,
    volumeIndent: 8,
    fallbackSize: null,
  });

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
        checksum/config: ${require('crypto').createHash('sha256').update(JSON.stringify(service.configMapData)).digest('hex').slice(0, 32)}` : ''}
    spec:
      automountServiceAccountToken: false
{{- if $.Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml $.Values.dataNodeSelector | indent 8 }}
{{- end }}
${pullsFromPrivateRegistry ? `{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
` : ''}{{- $svc := ${idx} }}
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
${(volumeMounts || configVolumeMounts) ? `
          volumeMounts:${volumeMounts}${configVolumeMounts}` : ''}${(volumes || configVolumes) ? `
      volumes:${volumes}${configVolumes}` : ''}
`.trim();
};
