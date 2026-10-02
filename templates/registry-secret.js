module.exports = () => {
  // Rendered only for a map value; toJson escapes whatever the password contains.
  return `
{{- if and .Values.imagePullSecret (kindIs "map" .Values.imagePullSecret) }}
{{- $reg := .Values.imagePullSecret }}
{{- $auth := printf "%s:%s" ($reg.username | toString) ($reg.password | toString) | b64enc }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Values.projectName }}-registry
  labels:
    app: {{ .Values.projectName }}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: {{ dict "auths" (dict ($reg.server | toString) (dict "username" ($reg.username | toString) "password" ($reg.password | toString) "auth" $auth)) | toJson | b64enc }}
{{- end }}
`.trim();
};
