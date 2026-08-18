module.exports = () => `
apiVersion: v1
kind: Service
metadata:
  name: frontend
  labels:
    app: {{ .Values.projectName }}
    component: frontend
spec:
  selector:
    app: {{ .Values.projectName }}
    component: frontend
  ports:
{{- range $i, $port := .Values.frontendPorts }}
    - name: port-{{ $port }}
      protocol: TCP
      port: {{ $port }}
      targetPort: {{ $port }}
{{- end }}
`.trim();
