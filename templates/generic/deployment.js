module.exports = (service) => {
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
      containers:
        - name: ${service.name}
          image: {{ if .Values.werf }}{{ index .Values.werf.image "${service.name}" }}{{ else }}{{ (index (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}")) "image") | default "${service.name}:latest" }}{{ end }}
{{- $serviceObj := index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}") }}
{{- if or $serviceObj.env $serviceObj.secretKeys }}
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
{{- end }}
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
