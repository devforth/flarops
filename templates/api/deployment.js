module.exports = () => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: {{ .Values.projectName }}
    component: api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: api
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: api
    spec:
      containers:
        - name: api
          image: {{ if .Values.werf }}{{ .Values.werf.image.api }}{{ else }}{{ .Values.images.api | default "api:latest" }}{{ end }}
{{- if .Values.env }}
          envFrom:
            - secretRef:
                name: {{ .Values.projectName }}-secrets
{{- end }}
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
`.trim();
