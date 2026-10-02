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
{{- $s := . | toString -}}
{{- $s = $s | replace "%" "%25" -}}
{{- $s = $s | replace " " "%20" -}}
{{- $s = $s | replace "\\"" "%22" -}}
{{- $s = $s | replace "#" "%23" -}}
{{- $s = $s | replace "$" "%24" -}}
{{- $s = $s | replace "&" "%26" -}}
{{- $s = $s | replace "'" "%27" -}}
{{- $s = $s | replace "(" "%28" -}}
{{- $s = $s | replace ")" "%29" -}}
{{- $s = $s | replace "*" "%2A" -}}
{{- $s = $s | replace "+" "%2B" -}}
{{- $s = $s | replace "," "%2C" -}}
{{- $s = $s | replace "/" "%2F" -}}
{{- $s = $s | replace ":" "%3A" -}}
{{- $s = $s | replace ";" "%3B" -}}
{{- $s = $s | replace "=" "%3D" -}}
{{- $s = $s | replace "?" "%3F" -}}
{{- $s = $s | replace "@" "%40" -}}
{{- $s = $s | replace "[" "%5B" -}}
{{- $s = $s | replace "\\\\" "%5C" -}}
{{- $s = $s | replace "]" "%5D" -}}
{{- $s -}}
{{- end -}}

{{- define "flarops.replicas" -}}
{{- if kindIs "invalid" . -}}1{{- else -}}{{ . }}{{- end -}}
{{- end -}}
`.trim();
