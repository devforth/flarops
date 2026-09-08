module.exports = (service) => {
  return `
apiVersion: v1
kind: Service
metadata:
  name: ${service.name}
spec:
  selector:
    app: {{ .Values.projectName }}
    component: ${service.name}
  ports:
{{- $serviceObj := index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}") }}
{{- range $port := $serviceObj.ports }}
    - port: {{ $port }}
      targetPort: {{ $port }}
      protocol: TCP
      name: http-{{ $port }}
{{- end }}
`.trim();
};
