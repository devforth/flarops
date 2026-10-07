// Shared chart helpers.
module.exports = () => `
{{- define "flarops.secretChecksum" -}}
{{- $env := .env | default dict -}}
{{- $picked := dict -}}
{{- range $k := (.keys | default list) -}}
{{- $_ := set $picked $k (index $env $k | default "") -}}
{{- end -}}
{{- printf "%s|%s" (toJson $picked) (toString (.password | default "")) | sha256sum -}}
{{- end -}}

{{- define "flarops.urlencode" -}}
{{- . | toString | urlquery | replace "+" "%20" -}}
{{- end -}}

{{- define "flarops.replicas" -}}
{{- if kindIs "invalid" . -}}1{{- else -}}{{ . }}{{- end -}}
{{- end -}}
`.trim();
