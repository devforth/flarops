// Images are pushed to the project's own registry repository, which is
// private for any paid/organisation account - and nothing in the generated
// chart ever told Kubernetes how to authenticate for the pull, so those pods
// sat in ImagePullBackOff with no hint as to why. The credentials are the
// same ones CI already uses for `docker login`; they reach the cluster the
// same way every other secret does (the CI-written values file), never
// through the chart in git.
module.exports = () => {
  // Guarded on the VALUE'S SHAPE, not just its truthiness: ".Values.
  // imagePullSecret" set to a plain string (a hand-edited values file, a
  // "--set imagePullSecret=..." meant as a name) made ".server" a field
  // lookup on a scalar, which aborts rendering of the entire chart rather
  // than just this one object.
  //
  // The document is built with dict/toJson rather than by printf-ing the
  // fields into a JSON-shaped string. A registry password is arbitrary text:
  // one containing a double quote or a backslash produced a .dockerconfigjson
  // that is not valid JSON, which the kubelet cannot parse - so the pull
  // failed as ImagePullBackOff with nothing pointing at the password as the
  // cause. toJson escapes whatever the value happens to contain.
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
