const { renderVolumes } = require('../generic/volumes.js');

module.exports = (config) => {
const { secretRefs, urlEncodedRef, alreadyEmitted } = require('../generic/env.js');

  const extraSecretEnvBlock = secretRefs(config && config.frontendExtraSecretEnvMappings);
  const hasExtraSecretEnv = extraSecretEnvBlock.length > 0;
  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const quoteKeys = (keys) => keys.filter(Boolean).map(k => JSON.stringify(k)).join(' ');
  const frontendExtraKeyList = quoteKeys(
    ((config && config.frontendExtraSecretEnvMappings) || []).map(m => m.secretKey)
  );

  const { pvcs, volumeMounts, volumes } = renderVolumes({ name: 'frontend', volumes: config && config.frontendVolumes }, { mountIndent: 12, volumeIndent: 8 });

  return `${pvcs}${pvcs ? '---\n' : ''}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: {{ .Values.projectName }}
    component: frontend
spec:
  replicas: {{ include "flarops.replicas" .Values.frontend.replicas }}${volumes ? `
  strategy:
    type: Recreate` : ''}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: frontend
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: frontend
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (concat (.Values.frontend.secretKeys | default list) (list ${frontendExtraKeyList}))) }}
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
      containers:
        - name: frontend
          image: {{ if .Values.werf }}{{ .Values.werf.image.frontend }}{{ else }}{{ .Values.images.frontend | default "frontend:latest" }}{{ end }}
{{- if .Values.frontend.command }}
          args:
{{- range $arg := .Values.frontend.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
{{- if or .Values.frontend.env .Values.frontend.secretKeys ${hasExtraSecretEnv} }}
          env:
{{- if .Values.frontend.env }}
{{- range $key, $value := .Values.frontend.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if .Values.frontend.secretKeys }}
{{- range $key := .Values.frontend.secretKeys }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}
{{- end }}${extraSecretEnvBlock}
{{- end }}
          livenessProbe:
            httpGet:
              path: /
              port: {{ index .Values.frontendPorts 0 | default 80 }}
            initialDelaySeconds: 10
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: /
              port: {{ index .Values.frontendPorts 0 | default 80 }}
            initialDelaySeconds: 5
            periodSeconds: 10${volumeMounts ? `
          volumeMounts:${volumeMounts}` : ''}${volumes ? `
      volumes:${volumes}` : ''}
`.trim();
};
