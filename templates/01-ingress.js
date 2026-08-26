module.exports = () => `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Values.projectName }}-ingress
  labels:
    app: {{ .Values.projectName }}
  annotations:
    kubernetes.io/ingress.class: "traefik"
spec:
  rules:
{{- if .Values.domain }}
    - host: {{ .Values.domain }}
      http:
{{- else }}
    - http:
{{- end }}
        paths:
{{- if .Values.apiRoutes }}
{{- range $route := .Values.apiRoutes }}
          - path: {{ $route }}
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: {{ index $.Values.apiPorts 0 | default 3000 }}
{{- end }}
{{- end }}
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: {{ index .Values.frontendPorts 0 }}
`.trim();
