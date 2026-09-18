module.exports = () => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: {{ .Values.projectName }}
    component: frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: frontend
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: frontend
    spec:
      automountServiceAccountToken: false
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
{{- if or .Values.frontend.env .Values.frontend.secretKeys }}
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
{{- end }}
{{- end }}
          resources:
            requests:
              memory: "128Mi"
              cpu: "10m"
            limits:
              memory: "256Mi"
              cpu: "500m"
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
