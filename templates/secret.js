// The project Secret. Keys spliced into a URL get a percent-encoded twin: $(VAR) copies bytes verbatim,
// so ":" or "@" in a password would break the URL.
module.exports = (urlEncodedKeys = []) => {
  const twins = urlEncodedKeys.filter(Boolean).map(key => `
{{- with (index (.Values.env | default dict) "${key}") }}
  ${key}_URLENCODED: {{ include "flarops.urlencode" . | quote }}
{{- end }}`).join('');

  return `
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
{{- end }}${twins}
`.trim();
};
