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
      containers:
        - name: frontend
          image: {{ if .Values.werf }}{{ .Values.werf.image.frontend }}{{ else }}{{ .Values.images.frontend | default "frontend:latest" }}{{ end }}
{{- if .Values.env }}
          envFrom:
            - secretRef:
                name: {{ .Values.projectName }}-secrets
{{- end }}
{{- if .Values.frontend.env }}
          env:
{{- range $key, $value := .Values.frontend.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "200m"
`.trim();
