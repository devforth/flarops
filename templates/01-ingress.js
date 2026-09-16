module.exports = (config) => `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Values.projectName }}-ingress
  labels:
    app: {{ .Values.projectName }}
  annotations:
{{- if ${config && config.hasCloudflare ? 'true' : 'false'} }}
    kubernetes.io/ingress.class: "traefik"
{{- else }}
    kubernetes.io/ingress.class: "traefik"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
{{- end }}
spec:
  ingressClassName: traefik
{{- if and .Values.domain (not ${config && config.hasCloudflare ? 'true' : 'false'}) }}
  tls:
    - hosts:
        - {{ .Values.domain }}
      secretName: {{ .Values.projectName }}-tls
{{- end }}
  rules:
{{- if .Values.domain }}
    - host: {{ .Values.domain }}
      http:
{{- else }}
    - http:
{{- end }}
        paths:
{{- if .Values.additionalServices }}
{{- range $service := .Values.additionalServices }}
{{- if $service.exposedRoutes }}
{{- range $route := $service.exposedRoutes }}
          - path: {{ $route }}
            pathType: Prefix
            backend:
              service:
                name: {{ $service.name }}
                port:
                  number: {{ index $service.ports 0 | default 80 }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- if and .Values.hasBackend .Values.apiRoutes }}
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
{{- if .Values.hasFrontend }}
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: {{ index .Values.frontendPorts 0 }}
{{- else if and .Values.hasBackend .Values.apiServesFrontend }}
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: {{ index .Values.apiPorts 0 | default 3000 }}
{{- end }}
`.trim();
