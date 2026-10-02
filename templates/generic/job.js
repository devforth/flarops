// A one-shot task: a Helm hook Job, re-run on every deploy, removed before the next run.
const { secretRefs, urlEncodedRef, alreadyEmitted } = require('./env.js');

module.exports = (service, { valuesRef }) => {
  const extraSecretEnvBlock = secretRefs(service.extraSecretEnvMappings);

  const hasEnvBlock = `{{- if or $svc.env $svc.secretKeys ${extraSecretEnvBlock ? 'true' : 'false'} }}`;

  const argsBlock = (Array.isArray(service.command) && service.command.length > 0) ? `
          args:
${service.command.map(a => `            - ${JSON.stringify(String(a))}`).join('\n')}` : '';

  const image = service.image
    ? `{{ $svc.image | default "${service.image}" }}`
    : `{{ if .Values.werf }}{{ index .Values.werf.image "${service.name}" }}{{ else }}{{ $svc.image | default "${service.name}:latest" }}{{ end }}`;

  return `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  backoffLimit: 4
{{- $svc := ${valuesRef} }}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${service.name}
    spec:
      restartPolicy: OnFailure
      automountServiceAccountToken: false
{{- if $.Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml $.Values.dataNodeSelector | indent 8 }}
{{- end }}
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
      containers:
        - name: ${service.name}
          image: ${image}${argsBlock}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
${hasEnvBlock}
          env:
{{- if $svc.env }}
{{- range $key, $value := $svc.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if $svc.secretKeys }}
{{- range $key := $svc.secretKeys }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}
{{- end }}${extraSecretEnvBlock}
{{- end }}
`.trim();
};
