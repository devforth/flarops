const { renderVolumes } = require('./volumes.js');
const { secretRefs, databaseEnv } = require('./env.js');

module.exports = (service) => {
  const { pvcs, volumeMounts, volumes } = renderVolumes(service, { mountIndent: 12, volumeIndent: 8 });
  // A ReadWriteOnce claim deadlocks a rolling update: Recreate.
  const strategyBlock = volumes ? `
  strategy:
    type: Recreate` : '';

  const dbEnv = databaseEnv(service);

  const extraSecretEnvBlock = secretRefs(service.extraSecretEnvMappings);

  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const extraKeyList = [
    ...(service.extraSecretEnvMappings || []).map(m => m.secretKey),
    ...dbEnv.keys,
  ].filter(Boolean).map(k => JSON.stringify(k)).join(' ');

  return `${pvcs}apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  replicas: {{ include "flarops.replicas" (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).replicas }}${strategyBlock}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: ${service.name}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${service.name}
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (concat ((index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).secretKeys | default list) (list ${extraKeyList})) "password" ((.Values.database | default dict).password | default "")) }}
    spec:
      automountServiceAccountToken: false
{{- if $.Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml $.Values.dataNodeSelector | indent 8 }}
      tolerations:
        - key: flarops.io/capsule
          operator: Equal
          value: "true"
          effect: NoSchedule
{{- end }}
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
{{- $serviceObj := index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int) }}
      containers:
        - name: ${service.name}
          image: {{ if .Values.werf }}{{ index .Values.werf.image "${service.name}" }}{{ else }}{{ (index (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)) "image") | default "${service.name}:latest" }}{{ end }}
{{- if $serviceObj.command }}
          args:
{{- range $arg := $serviceObj.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
{{- if or $serviceObj.env $serviceObj.secretKeys ${dbEnv.block ? 'true' : 'false'} ${(Array.isArray(service.extraSecretEnvMappings) && service.extraSecretEnvMappings.length > 0) ? 'true' : 'false'} }}
          env:
{{- if $serviceObj.env }}
{{- range $key, $value := $serviceObj.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if $serviceObj.secretKeys }}
{{- range $key := $serviceObj.secretKeys }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}
{{- end }}${dbEnv.block}${extraSecretEnvBlock}
{{- end }}
{{- if $serviceObj.healthRoute }}
          startupProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
{{- end }}${volumeMounts ? `
          volumeMounts:${volumeMounts}` : ''}${volumes ? `
      volumes:${volumes}` : ''}
`.trim();
};
