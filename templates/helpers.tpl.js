// Shared chart helpers.
module.exports = () => `
{{/*
The pod-template annotation that forces a rollout when secret material changes
used to hash the WHOLE .Values.env map in every workload, so rotating any one
secret restarted every pod in the project - including the ones that never read
it. This picks out only the keys a given workload actually consumes, so a
rotation rolls exactly the pods that depend on it.

Takes a dict: "env" (the secret map), "keys" (the key names this workload
mounts) and "password" (the database password, for the workloads wired to it).
A workload consuming neither still gets a stable, non-empty hash.
*/}}
{{- define "flarops.secretChecksum" -}}
{{- $env := .env | default dict -}}
{{- $picked := dict -}}
{{- range $k := (.keys | default list) -}}
{{- $_ := set $picked $k (index $env $k | default "") -}}
{{- end -}}
{{- printf "%s|%s" (toJson $picked) (toString (.password | default "")) | sha256sum -}}
{{- end -}}

{{/*
Percent-encodes a value so it can be placed inside a URL's userinfo.

A database password reaches the container as its own environment variable and
is spliced into DATABASE_URL by Kubernetes' "$(VAR)" substitution, which copies
the bytes verbatim. A password containing ":" "/" "?" "#" "@" or "%" - all of
which a password generator may legitimately produce - then terminates the URL
early: the driver reads part of the password as a port and refuses to connect
with "invalid port number in database URL". The password is correct, the URL is
not.

Encoding cannot happen where the value is used, because at that point it is a
runtime env var Helm never sees. It happens here, on the way INTO the Secret,
so the container is handed a second variable that is already safe to splice.

sprig's urlquery is not used: it encodes a space as "+", which is correct for a
query string and wrong for userinfo, where "+" stands for itself. The set below
is RFC 3986's reserved characters plus space and the delimiters a URL parser
acts on. "%" is replaced FIRST, or the escapes introduced by later replacements
would themselves be re-encoded.
*/}}
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

{{/*
A replica count that keeps an explicit 0.

"{{ .replicas | default 1 }}" cannot express "scaled to zero": sprig's default
treats 0 as empty exactly like nil, so setting replicas: 0 in values.yaml
silently brought the workload back up with one pod and there was no way to stop
a service from the chart at all. Only an absent value falls back.
*/}}
{{- define "flarops.replicas" -}}
{{- if kindIs "invalid" . -}}1{{- else -}}{{ . }}{{- end -}}
{{- end -}}
`.trim();
