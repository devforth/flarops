// A one-shot task: something that runs to completion and stops.
//
// Creating Kafka topics, seeding a store, registering a webhook - a stack has
// tasks that are not services. Declared as a service with `replicas: 1`, such
// a task becomes a Deployment, which is a promise that one copy is always
// running: the container exits, Kubernetes restarts it, and it lands in
// CrashLoopBackOff forever, doing its work over and over on the way. Nothing
// about that is visible in the declaration, which is why it needs a field of
// its own.
//
// Rendered as a Helm hook so it runs on every install and upgrade, in the same
// release, with the same values and the same Secret as everything else.
// `before-hook-creation` deletes the previous Job first, because a Job's pod
// template is immutable and the name is fixed - without it the second deploy
// fails on a conflict. The task must therefore be safe to run again, which is
// the normal shape for this kind of work (`--if-not-exists`, an upsert, a
// no-op on a store that is already seeded).

module.exports = (service, { valuesRef }) => {
  let extraSecretEnvBlock = '';
  for (const mapping of service.extraSecretEnvMappings || []) {
    extraSecretEnvBlock += `
            - name: ${mapping.envName}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${mapping.secretKey}`;
  }

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
  # Bounded. A task that cannot succeed should stop and be visible, not retry
  # until someone notices the bill.
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
