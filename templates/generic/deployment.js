module.exports = (service) => {
  // Same pitfall as api/deployment.js: when this service's own source code
  // reads the DB password under a name that also independently qualifies as
  // "sensitive" (so it's already in service.secretKeys), adding this block
  // unconditionally on top would emit that env var name twice in the same
  // container - which Kubernetes' server-side apply rejects outright.
  const dbPasswordAlreadyInSecretKeys = Array.isArray(service.secretKeys) && service.secretKeys.includes(service.dbPasswordKey);
  const dbPasswordBlock = (service.dbPasswordKey && !dbPasswordAlreadyInSecretKeys) ? `
            - name: ${service.dbPasswordKey}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.dbPasswordKey}` : '';

  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: ${service.name}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${service.name}
    spec:
      automountServiceAccountToken: false
      containers:
        - name: ${service.name}
          image: {{ if .Values.werf }}{{ index .Values.werf.image "${service.name}" }}{{ else }}{{ (index (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)) "image") | default "${service.name}:latest" }}{{ end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
{{- $serviceObj := index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int) }}
{{- if or $serviceObj.env $serviceObj.secretKeys ${service.dbPasswordKey ? 'true' : 'false'} }}
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
{{- end }}${dbPasswordBlock}
{{- end }}
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
{{- if $serviceObj.healthRoute }}
          livenessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ index $serviceObj.ports 0 | default 80 }}
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ index $serviceObj.ports 0 | default 80 }}
            initialDelaySeconds: 5
            periodSeconds: 10
{{- end }}
`.trim();
};
