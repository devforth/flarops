const { normalizeRoutes, stripMiddlewareName } = require('../utils/routes.js');

module.exports = (config) => {
  // Traefik applies a middleware to an INGRESS, not to a path: the annotation
  // names middlewares for every router the object generates. A route that
  // strips its prefix therefore needs an Ingress of its own, carrying only
  // that route and only that annotation - which is also why each distinct
  // prefix gets its own Middleware rather than one shared object.
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

  const stripObjects = stripped.map(({ route, service, portExpr }) => {
    const name = stripMiddlewareName(config.projectName, route.path);
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
      - ${route.path}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}-ingress
  labels:
    app: {{ .Values.projectName }}
  annotations:
    kubernetes.io/ingress.class: "traefik"
    # Namespaced reference: Traefik resolves "<namespace>-<name>@kubernetescrd".
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
          - path: ${route.path}
            pathType: Prefix
            backend:
              service:
                name: ${service}
                port:
                  number: ${portExpr}`;
  }).join('');

  return `
{{/*
An Ingress with an empty paths list is not merely useless - "paths: null"
fails HTTPIngressRuleValue's schema and the API server rejects the object, so
werf converge aborts and NOTHING deploys. A project can legitimately end up
with no public route (every service behind a gateway that itself exposes
nothing, or two services whose conflicting prefixes were both dropped), and
that should leave the services running and reachable inside the cluster rather
than blocking the whole deployment. init prints a NOTE when it happens.
*/}}
{{/*
Routes that strip a prefix are NOT counted here: they live in their own Ingress
below, because Traefik applies a middleware to a whole Ingress rather than to
one path. Counting them would let this object render with an empty paths list
when every route strips - the exact "paths: null" the note above is about.
*/}}
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
    # No cert-manager issuer and no tls: block, on either path.
    #
    # The non-Cloudflare path used to declare both, and the certificate was
    # even issued - HTTP-01 only needs port 80. But the generated security
    # group opens 22, 80 and 6443 and nothing else, so 443 was unreachable and
    # every request stayed cleartext while the chart claimed otherwise. A
    # declared-but-unserviceable TLS is worse than none: it reads as secure in
    # the manifest, and the dashboard's Secure/__Host- cookies are then
    # rejected by the browser on an http:// origin, so login cannot complete
    # at all. TLS termination belongs in front of the cluster (Cloudflare, or
    # whatever the operator puts there), which is where it already was on the
    # only path that worked.
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
