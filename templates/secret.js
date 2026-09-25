// The Secret every workload's credentials come from.
//
// `urlEncodedKeys` names the keys that also need a percent-encoded twin. A
// database password is spliced into DATABASE_URL by Kubernetes' "$(VAR)"
// substitution at container start, which copies the bytes verbatim - so a
// password holding ":" "/" "?" "#" "@" or "%" breaks the URL and the driver
// reports "invalid port number". Helm cannot encode it at the point of use,
// because there the value is a runtime variable it never sees; it can encode
// it here, on the way in, and hand the container a second variable that is
// already safe to splice.
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
