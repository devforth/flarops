module.exports = (service) => {
  // Same pitfall as api/deployment.js: when this service's own source code
  // reads the DB password under a name that also independently qualifies as
  // "sensitive" (so it's already in service.secretKeys), adding this block
  // unconditionally on top would emit that env var name twice in the same
  // container - which Kubernetes' server-side apply rejects outright.
  const dbPasswordAlreadyInSecretKeys = Array.isArray(service.secretKeys) && service.secretKeys.includes(service.dbPasswordKey);
  const dbPasswordBlock = (service.dbPasswordKey && !dbPasswordAlreadyInSecretKeys) ? `
            - name: ${service.dbPasswordKey}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.dbPasswordKey}` : '';

  // Spring Boot binds SPRING_DATASOURCE_PASSWORD automatically (relaxed env
  // var binding) - this service's own database (see analyzeDatabase /
  // analyzeServiceDatabaseFromCompose in init.js), which is entirely separate
  // from the project's shared primary database above.
  const springDatasourcePasswordBlock = service.springDatasourcePasswordSecretKey ? `
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.springDatasourcePasswordSecretKey}` : '';

  // Generic (non-Spring) fallback: a hardcoded connection string in this
  // service's own source was rewritten (refactorBackendDbUrl) to read from
  // an env var - wire that var to this service's own database, using the
  // K8s $(VAR) interpolation trick to pull in the password secret defined
  // just above without ever putting it in plain text.
  let ownDbUrlBlock = '';
  if (service.db && Array.isArray(service.dbUrlVars) && service.dbUrlVars.length > 0) {
    const db = service.db;
    // A distinct database gets its own dedicated StatefulSet, reached at
    // "<service>-db" (see templates/generic/database.js); a database shared
    // with the project's primary backend is the existing "database" Service.
    const dbHost = db.shared ? 'database' : `${service.name}-db`;
    let scheme = 'postgres';
    if (db.type === 'mysql' || db.type === 'mariadb') scheme = 'mysql';
    else if (db.type === 'mongodb') scheme = 'mongodb';
    const authSuffix = scheme === 'mongodb' ? '?authSource=admin' : '';
    for (const urlVar of service.dbUrlVars) {
      // A shared database has no single fixed name of its own - each
      // service using it declared its own db name in docker-compose (see the
      // compose environment: scan in init.js), captured per-var here.
      const dbName = urlVar.dbName || db.name;
      ownDbUrlBlock += `
            - name: ${urlVar.key}
              value: "${scheme}://${db.user}:$(${db.passwordKey})@${dbHost}:${db.port}/${dbName}${authSuffix}"`;
    }
  }

  // A service whose own code reads the DB password under a name that doesn't
  // match the shared secret's key (e.g. it expects DB_PASS, but the secret is
  // keyed MONGO_INITDB_ROOT_PASSWORD) still needs that exact env var name in
  // its container - a secretKeyRef's container-side name and its key in the
  // Secret don't have to match.
  let extraSecretEnvBlock = '';
  if (Array.isArray(service.extraSecretEnvMappings)) {
    for (const mapping of service.extraSecretEnvMappings) {
      extraSecretEnvBlock += `
            - name: ${mapping.envName}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${mapping.secretKey}`;
    }
  }

  // The keys above are rendered straight into the manifest (their container-
  // side names differ from the Secret keys), so they are invisible to the
  // secretKeys list the checksum otherwise reads - name them explicitly or a
  // rotation of one of them would not roll this pod.
  const extraKeyList = [
    ...(service.extraSecretEnvMappings || []).map(m => m.secretKey),
    service.dbPasswordKey,
    service.springDatasourcePasswordSecretKey,
  ].filter(Boolean).map(k => JSON.stringify(k)).join(' ');

  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  replicas: {{ include "flarops.replicas" (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).replicas }}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: ${service.name}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${service.name}
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (concat ((index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).secretKeys | default list) (list ${extraKeyList})) "password" ((.Values.database | default dict).password | default "")) }}
    spec:
      automountServiceAccountToken: false
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
{{- $serviceObj := index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int) }}
      containers:
        - name: ${service.name}
          image: {{ if .Values.werf }}{{ index .Values.werf.image "${service.name}" }}{{ else }}{{ (index (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)) "image") | default "${service.name}:latest" }}{{ end }}
{{- if $serviceObj.command }}
          args:
{{- range $arg := $serviceObj.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
{{- if or $serviceObj.env $serviceObj.secretKeys ${service.dbPasswordKey ? 'true' : 'false'} ${service.springDatasourcePasswordSecretKey ? 'true' : 'false'} ${(Array.isArray(service.extraSecretEnvMappings) && service.extraSecretEnvMappings.length > 0) ? 'true' : 'false'} }}
          env:
{{- if $serviceObj.env }}
{{- range $key, $value := $serviceObj.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- if $serviceObj.secretKeys }}
{{- range $key := $serviceObj.secretKeys }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: {{ $key }}
{{- end }}
{{- end }}${dbPasswordBlock}${springDatasourcePasswordBlock}${ownDbUrlBlock}${extraSecretEnvBlock}
{{- end }}
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
{{- if $serviceObj.healthRoute }}
          # A startup probe covers the (often long) boot of a JVM/runtime
          # without forcing the liveness probe to be slack for the whole life
          # of the pod: liveness only begins once startup has succeeded, so a
          # slow start no longer reads as a crash, and a real hang is still
          # caught quickly afterwards.
          startupProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 10
            # A JVM answering its first probes while still warming up regularly
            # needs more than the 1s default, and a probe that times out counts
            # as a failure exactly like a 404 would.
            timeoutSeconds: 5
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
{{- end }}
`.trim();
};
