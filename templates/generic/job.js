// A one-shot task: a Helm hook Job, re-run on every deploy, removed before the next run.
const { secretRefs, databaseEnv } = require('./env.js');

module.exports = (service, { valuesRef }) => {
  const extraSecretEnvBlock = secretRefs(service.extraSecretEnvMappings);
  const dbEnv = databaseEnv(service);

  const hasEnvBlock = `{{- if or $svc.env $svc.secretKeys ${extraSecretEnvBlock || dbEnv.block ? 'true' : 'false'} }}`;

  // From values, like every other workload: an argument holding "{{" stays text.
  const argsBlock = `
{{- if $svc.command }}
          args:
{{- range $arg := $svc.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}`;

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
{{- end }}${dbEnv.block}${extraSecretEnvBlock}
{{- end }}
`.trim();
};
