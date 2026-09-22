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
