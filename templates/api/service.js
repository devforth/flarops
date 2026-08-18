module.exports = () => `
apiVersion: v1
kind: Service
metadata:
  name: api
  labels:
    app: {{ .Values.projectName }}
    component: api
spec:
  selector:
    app: {{ .Values.projectName }}
    component: api
  ports:
{{- range $port := .Values.apiPorts }}
    - name: port-{{ $port }}
      protocol: TCP
      port: {{ $port }}
      targetPort: {{ $port }}
{{- end }}
`.trim();
