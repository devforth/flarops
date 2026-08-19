module.exports = () => `
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Values.projectName }}-secrets
  labels:
    app: {{ .Values.projectName }}
type: Opaque
stringData:
{{- if .Values.env }}
{{- range $key, $value := .Values.env }}
  {{ $key }}: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if .Values.database }}
  DATABASE_PASSWORD: {{ .Values.database.password | quote }}
{{- end }}
`.trim();
