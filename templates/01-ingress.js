const { normalizeRoutes, stripMiddlewareNames } = require('../utils/routes.js');
const { helmLiteral } = require('./generic/env.js');

module.exports = (config) => {
  // Traefik applies middlewares per Ingress, so each stripped prefix gets its own Middleware and Ingress.
  const stripped = [];
  for (const route of normalizeRoutes(config.apiRoutes)) {
    if (route.stripPrefix) stripped.push({ route, service: 'api', portExpr: '{{ index .Values.apiPorts 0 | default 3000 }}' });
  }
  for (const service of config.additionalServices || []) {
    if (service.suppressDirectIngress) continue;
    for (const route of normalizeRoutes(service.exposedRoutes)) {
      if (route.stripPrefix) {
        stripped.push({ route, service: service.name, portExpr: String((service.ports || [80])[0]) });
      }
    }
  }

  const names = stripMiddlewareNames(config.projectName, stripped.map(s => s.route.path));

  const stripObjects = stripped.map(({ route, service, portExpr }) => {
    const name = names.get(route.path);
    return `
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: ${name}
  labels:
    app: {{ .Values.projectName }}
spec:
  stripPrefix:
    prefixes:
      - ${helmLiteral(route.path)}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}-ingress
  labels:
    app: {{ .Values.projectName }}
  annotations:
    kubernetes.io/ingress.class: "traefik"
    traefik.ingress.kubernetes.io/router.middlewares: "{{ .Release.Namespace }}-${name}@kubernetescrd"
spec:
  ingressClassName: traefik
  rules:
{{- if .Values.domain }}
    - host: {{ .Values.domain }}
      http:
{{- else }}
    - http:
{{- end }}
        paths:
          - path: ${helmLiteral(route.path)}
            pathType: Prefix
            backend:
              service:
                name: ${service}
                port:
                  number: ${portExpr}`;
  }).join('');

  return `
{{- $hasApiRoutes := false }}
{{- if .Values.hasBackend }}
{{- range $route := (.Values.apiRoutes | default list) }}
{{- if not $route.stripPrefix }}{{ $hasApiRoutes = true }}{{ end }}
{{- end }}
{{- end }}
{{- $hasDirect := false }}
{{- range $service := (.Values.additionalServices | default list) }}
{{- if $service.exposeDirectly }}
{{- range $route := ($service.exposedRoutes | default list) }}
{{- if not $route.stripPrefix }}{{ $hasDirect = true }}{{ end }}
{{- end }}
{{- end }}
{{- end }}
{{- $hasRoot := or .Values.hasFrontend (and .Values.hasBackend .Values.apiServesFrontend) }}
{{- if or $hasApiRoutes $hasDirect $hasRoot }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Values.projectName }}-ingress
  labels:
    app: {{ .Values.projectName }}
  annotations:
    kubernetes.io/ingress.class: "traefik"
spec:
  ingressClassName: traefik
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
{{- if $service.exposeDirectly }}
{{- range $route := $service.exposedRoutes }}
{{- if not $route.stripPrefix }}
          - path: {{ $route.path }}
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
{{- end }}
{{- end }}
{{- if and .Values.hasBackend .Values.apiRoutes }}
{{- range $route := .Values.apiRoutes }}
{{- if not $route.stripPrefix }}
          - path: {{ $route.path }}
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: {{ index $.Values.apiPorts 0 | default 3000 }}
{{- end }}
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
{{- end }}
`.trim() + stripObjects;
};
