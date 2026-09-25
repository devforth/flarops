module.exports = (config) => {
  // A shared credential whose env var name on the primary backend doesn't
  // match the canonical secret key it was generated under - the container-
  // side name and the Secret's own key are independent, exactly like
  // generic/deployment.js's extraSecretEnvMappings.
  let extraSecretEnvBlock = '';
  if (Array.isArray(config.apiExtraSecretEnvMappings)) {
    for (const mapping of config.apiExtraSecretEnvMappings) {
      extraSecretEnvBlock += `
            - name: ${mapping.envName}
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${mapping.secretKey}`;
    }
  }
  const hasExtraSecretEnv = extraSecretEnvBlock.length > 0;
  // The keys above are rendered straight into the manifest (their container-
  // side names differ from the Secret keys), so they are invisible to the
  // secretKeys list the checksum otherwise reads - name them explicitly or a
  // rotation of one of them would not roll this pod.
  const quoteKeys = (keys) => keys.filter(Boolean).map(k => JSON.stringify(k)).join(' ');
  const apiExtraKeyList = quoteKeys([
    ...(config.apiExtraSecretEnvMappings || []).map(m => m.secretKey),
    config.dbPasswordKey,
    // Rendered straight into the manifest like the mappings above, so it is
    // invisible to the checksum unless named: rotating the password must roll
    // this pod, and the encoded twin is what it actually reads.
    (config.dbUrlVars || []).length > 0 && config.dbPasswordKey ? `${config.dbPasswordKey}_URLENCODED` : null,
  ]);



  let dbUrlEnvBlock = '';
  if (config.dbUrlVars && config.dbUrlVars.length > 0 && config.dbType) {
    let scheme = 'postgres';
    let defaultPort = 5432;
    let mongoAuth = '';

    if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
      scheme = 'mysql';
      defaultPort = 3306;
    } else if (config.dbType === 'mongodb') {
      scheme = 'mongodb';
      defaultPort = 27017;
      mongoAuth = '?authSource=admin';
    }

    if (config.dbPort) defaultPort = config.dbPort;

    // The percent-encoded twin of the password, declared BEFORE the URLs that
    // splice it in: Kubernetes expands "$(VAR)" only against variables already
    // listed above it in the same container. Splicing the raw password here is
    // what produced "invalid port number in database URL" - see
    // flarops.urlencode in _helpers.tpl.
    dbUrlEnvBlock += `
            - name: ${config.dbPasswordKey}_URLENCODED
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${config.dbPasswordKey}_URLENCODED`;

    for (const urlVar of config.dbUrlVars) {
      let query = urlVar.query || '';
      if (scheme === 'mongodb' && !query.includes('authSource')) {
        query += (query ? '&' : '') + mongoAuth;
      }

      // The user and database name are Helm values, so they are encoded here,
      // at render time, by the same rule.
      dbUrlEnvBlock += `
            - name: ${urlVar.key}
              value: "${scheme}://{{ include "flarops.urlencode" .Values.database.user }}:$(${config.dbPasswordKey}_URLENCODED)@database:{{ .Values.dbPort | default ${defaultPort} }}/{{ include "flarops.urlencode" .Values.database.name }}${query}"`;
    }
  }

  let hasCustomEnv = config.dbUrlVars && config.dbUrlVars.length > 0;

  // Gate the DB password wiring on the JS-side "was a password actually
  // generated/found" signal, not on `.Values.database` - that object is always
  // present in values.yaml regardless of whether a database was ever detected,
  // so a Helm-side `{{- if .Values.database }}` check was always true and wired
  // a DATABASE_PASSWORD secretKeyRef into every project, DB or not.
  //
  // When the backend's own source code reads the DB password under a name
  // that also happens to look "sensitive" (e.g. DB_PASSWORD, matched by both
  // analyzeBackendForDbKeys AND the generic sensitiveRegex/usedEnvVars path),
  // that same key already ends up in config.apiSecretKeys. Adding this block
  // unconditionally on top of that produced two `- name: DB_PASSWORD` entries
  // in the same container's env list, which Kubernetes' server-side apply
  // rejects outright ("duplicate entries for key").
  const hasDbPassword = !!config.hasDbPassword;
  // "Already emitted" means under this container-side NAME, by any of the
  // mechanisms that write into the same env list - the generic secretKeys
  // loop, or an explicit mapping whose envName happens to be this one. The
  // check used to look at secretKeys alone, so a shared credential recorded
  // as a mapping (DB_PASSWORD -> POSTGRES_PASSWORD) was emitted here a second
  // time under its own name, and the API server rejects the Deployment for
  // the duplicate.
  const dbPasswordAlreadyEmitted =
    (Array.isArray(config.apiSecretKeys) && config.apiSecretKeys.includes(config.dbPasswordKey)) ||
    (config.apiExtraSecretEnvMappings || []).some(m => m.envName === config.dbPasswordKey);
  const dbPasswordBlock = (hasDbPassword && !dbPasswordAlreadyEmitted) ? `
            - name: {{ "${config.dbPasswordKey}" }}
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: {{ "${config.dbPasswordKey}" }}` : '';

  const envBlock = `
{{- if or .Values.api.env .Values.api.secretKeys ${hasDbPassword ? 'true' : 'false'} ${hasCustomEnv ? 'true' : 'false'} ${hasExtraSecretEnv ? 'true' : 'false'} }}
          env:
{{- if .Values.api.env }}
{{- range $key, $value := .Values.api.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if .Values.api.secretKeys }}
{{- range $key := .Values.api.secretKeys }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}
{{- end }}
${dbPasswordBlock}${dbUrlEnvBlock}${extraSecretEnvBlock}
{{- end }}`;

  // A prestart/migration step (e.g. `alembic upgrade head` + seeding the
  // first superuser, or Django's `manage.py migrate`) has to run to
  // completion exactly once before the API can serve real traffic - running
  // it as the main container's command would mean it never turns into a
  // long-running server, and running it inside the main container after
  // startup races every replica against the same migration. An initContainer
  // with the same image/env is the standard way to do this in Kubernetes: it
  // runs to completion before the api container starts. The check file's
  // exact location relative to the backend is only a best guess
  // (detectApiMigrationStep in utils/analyzer.js), so the command checks it
  // exists first and skips instead of hard-failing - a wrong guess should
  // behave like this feature was never detected, not permanently block the
  // whole deployment from ever starting.
  // Some apps (notably Go binaries using the stdlib `flag` package) take
  // essential runtime config exclusively via CLI arguments, invisible to
  // every env-var-based mechanism above - docker-compose's own `command:`
  // override for this service (already rewritten to point at real k8s
  // Service names in init.js) is carried over here the same way.
  const apiArgsBlock = (Array.isArray(config.apiCommand) && config.apiCommand.length > 0) ? `
          args:
${config.apiCommand.map(a => `            - ${JSON.stringify(String(a))}`).join('\n')}` : '';

  const prestartInitContainer = config.apiMigrationStep ? `
      initContainers:
        - name: api-prestart
          image: {{ if .Values.werf }}{{ .Values.werf.image.api }}{{ else }}{{ .Values.images.api | default "api:latest" }}{{ end }}
          command: ["bash", "-c", "if [ -f ${config.apiMigrationStep.checkFile} ]; then ${config.apiMigrationStep.command}; else echo 'Skipping: ${config.apiMigrationStep.checkFile} not found in this image'; fi"]
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
${envBlock}` : '';

  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: {{ .Values.projectName }}
    component: api
spec:
  replicas: {{ include "flarops.replicas" .Values.api.replicas }}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: api
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: api
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (concat (.Values.api.secretKeys | default list) (list ${apiExtraKeyList})) "password" ((.Values.database | default dict).password | default "")) }}
    spec:
      automountServiceAccountToken: false
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
${prestartInitContainer}
      containers:
        - name: api
          image: {{ if .Values.werf }}{{ .Values.werf.image.api }}{{ else }}{{ .Values.images.api | default "api:latest" }}{{ end }}${apiArgsBlock}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
${envBlock}
          # No resource requests or limits are set here on purpose. A generated
          # figure is a guess about someone else's workload, and the two ways it
          # can be wrong are both bad: too low and the pod is OOM-killed or
          # throttled under load, too high and the scheduler reserves capacity
          # nothing uses, which is exactly the capacity the capsule placement
          # maths is trying to account for. Set them per service in
          # deploy/helm/values.yaml when the real numbers are known.
{{- if .Values.api.healthRoute }}
          # A startup probe covers the (often long) boot of a JVM/runtime
          # without forcing the liveness probe to be slack for the whole life
          # of the pod: liveness only begins once startup has succeeded, so a
          # slow start no longer reads as a crash, and a real hang is still
          # caught quickly afterwards.
          startupProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ .Values.api.healthPort | default (index .Values.apiPorts 0) | default 3000 }}
            periodSeconds: 10
            # A JVM answering its first probes while still warming up regularly
            # needs more than the 1s default, and a probe that times out counts
            # as a failure exactly like a 404 would.
            timeoutSeconds: 5
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ .Values.api.healthPort | default (index .Values.apiPorts 0) | default 3000 }}
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ .Values.api.healthPort | default (index .Values.apiPorts 0) | default 3000 }}
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
{{- end }}
`.trim();
};
