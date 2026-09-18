module.exports = (config) => {
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

    for (const urlVar of config.dbUrlVars) {
      let query = urlVar.query || '';
      if (scheme === 'mongodb' && !query.includes('authSource')) {
        query += (query ? '&' : '') + mongoAuth;
      }

      dbUrlEnvBlock += `
            - name: ${urlVar.key}
              value: "${scheme}://{{ .Values.database.user }}:$(${config.dbPasswordKey})@database:{{ .Values.dbPort | default ${defaultPort} }}/{{ .Values.database.name }}${query}"`;
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
  const dbPasswordAlreadyInSecretKeys = Array.isArray(config.apiSecretKeys) && config.apiSecretKeys.includes(config.dbPasswordKey);
  const dbPasswordBlock = (hasDbPassword && !dbPasswordAlreadyInSecretKeys) ? `
            - name: {{ "${config.dbPasswordKey}" }}
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: {{ "${config.dbPasswordKey}" }}` : '';

  const envBlock = `
{{- if or .Values.api.env .Values.api.secretKeys ${hasDbPassword ? 'true' : 'false'} ${hasCustomEnv ? 'true' : 'false'} }}
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
${dbPasswordBlock}${dbUrlEnvBlock}
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
  // Each extra worker is a full copy of the process - scale memory with the
  // count so multi-worker images (uvicorn/gunicorn `--workers N`) don't get
  // OOMKilled against a limit sized for a single process. workers=1 keeps the
  // original hardcoded 256Mi/512Mi exactly, so single-process images are
  // unaffected.
  const apiWorkers = Math.max(1, config.apiWorkers || 1);
  const apiMemoryRequestMi = Math.max(256, apiWorkers * 128);
  const apiMemoryLimitMi = Math.max(512, apiWorkers * 200);

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
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: api
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: api
    spec:
      automountServiceAccountToken: false
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
          resources:
            requests:
              memory: "${apiMemoryRequestMi}Mi"
              cpu: "300m"
            limits:
              memory: "${apiMemoryLimitMi}Mi"
              cpu: "1000m"
{{- if .Values.api.healthRoute }}
          livenessProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ index .Values.apiPorts 0 | default 3000 }}
            initialDelaySeconds: 15
            periodSeconds: 20
          readinessProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ index .Values.apiPorts 0 | default 3000 }}
            initialDelaySeconds: 5
            periodSeconds: 10
{{- end }}
`.trim();
};
