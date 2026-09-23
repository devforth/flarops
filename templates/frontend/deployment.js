module.exports = (config) => {
  // A shared credential (see tryWireSharedCredential in init.js) whose env
  // var name on the frontend doesn't match the canonical secret key it was
  // generated under - the container-side name and the Secret's own key are
  // independent, exactly like generic/deployment.js's extraSecretEnvMappings.
  let extraSecretEnvBlock = '';
  if (config && Array.isArray(config.frontendExtraSecretEnvMappings)) {
    for (const mapping of config.frontendExtraSecretEnvMappings) {
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
  const frontendExtraKeyList = quoteKeys(
    ((config && config.frontendExtraSecretEnvMappings) || []).map(m => m.secretKey)
  );


  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: {{ .Values.projectName }}
    component: frontend
spec:
  replicas: {{ include "flarops.replicas" .Values.frontend.replicas }}
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
          # No resource requests or limits are set here on purpose. A generated
          # figure is a guess about someone else's workload, and the two ways it
          # can be wrong are both bad: too low and the pod is OOM-killed or
          # throttled under load, too high and the scheduler reserves capacity
          # nothing uses, which is exactly the capacity the capsule placement
          # maths is trying to account for. Set them per service in
          # deploy/helm/values.yaml when the real numbers are known.
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
            periodSeconds: 10
`.trim();
};
