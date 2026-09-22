// Postgres 18 changed the docker image's on-disk layout to be
// pg_ctlcluster-style, namespaced per major version (e.g.
// /var/lib/postgresql/18/docker) - see
// https://github.com/docker-library/postgres/pull/1259. Mounting a volume
// straight at the old /var/lib/postgresql/data path now makes the entrypoint
// see "data in an unused mount" and refuse to start. From 18 onward the
// volume has to be mounted one level up, at /var/lib/postgresql, so the image
// can manage its own version-specific subdirectory underneath it.
function getPostgresMajorVersion(image) {
  const tag = (image || '').split(':')[1] || '';
  const match = tag.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// A database that is Running is not necessarily a database that accepts
// connections - the engine still has to initialise, and on first boot it also
// creates the user and schema. Without probes, traffic (and the PR-capsule
// clone step, which waits on `kubectl rollout status`) was routed at it the
// moment the pod started, which is why "connection refused" showed up as an
// application error rather than as an unready pod.
function buildProbeCommand(dbType, image) {
  if (dbType === 'postgres' || dbType === 'postgresql') {
    // Run through a shell for the same reason the MySQL branch does: the
    // "$(VAR)" substitution Kubernetes performs on a container's command and
    // args is NOT performed on a probe's exec command, so "pg_isready -U
    // $(POSTGRES_USER)" passed that text to pg_isready verbatim. It still
    // exited 0 - pg_isready reports any answering server as up regardless of
    // the user or database named - so the probe looked healthy while checking
    // none of what it was added to check: that the engine had finished
    // creating this application's user and schema.
    return ['sh', '-c', 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'];
  }
  if (dbType === 'mysql' || dbType === 'mariadb') {
    const passVar = dbType === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
    return ['sh', '-c', `mysqladmin ping -h 127.0.0.1 -u root -p"$${passVar}" --silent`];
  }
  if (dbType === 'mongodb') {
    // The shell binary was renamed in MongoDB 6: "mongo" before, "mongosh"
    // after. Probing with the wrong one fails permanently, so pick by tag and
    // fall back to whichever exists.
    return ['sh', '-c', `(mongosh --quiet --eval 'db.adminCommand("ping")' || mongo --quiet --eval 'db.adminCommand("ping")')`];
  }
  return null;
}

function renderProbes(dbType, image, indent = '          ') {
  const cmd = buildProbeCommand(dbType, image);
  if (!cmd) return '';
  const asYaml = cmd.map(part => JSON.stringify(part)).join(', ');
  return `
${indent}livenessProbe:
${indent}  exec:
${indent}    command: [${asYaml}]
${indent}  initialDelaySeconds: 30
${indent}  periodSeconds: 20
${indent}  timeoutSeconds: 5
${indent}  failureThreshold: 6
${indent}readinessProbe:
${indent}  exec:
${indent}    command: [${asYaml}]
${indent}  initialDelaySeconds: 5
${indent}  periodSeconds: 10
${indent}  timeoutSeconds: 5
${indent}  failureThreshold: 6`;
}

module.exports = (config) => {
  let envBlock = '';
  let volumeMountPath = '/var/lib/data';

  if (config.dbType === 'postgres' || config.dbType === 'postgresql') {
    envBlock = `
            - name: POSTGRES_USER
              value: {{ .Values.database.user | quote }}
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${config.dbPasswordKey}
            - name: POSTGRES_DB
              value: {{ .Values.database.name | quote }}`;
    const pgMajorVersion = getPostgresMajorVersion(config.images && config.images.db);
    volumeMountPath = (pgMajorVersion && pgMajorVersion >= 18) ? '/var/lib/postgresql' : '/var/lib/postgresql/data';
  } else if (config.dbType === 'mysql' || config.dbType === 'mariadb') {
    const prefix = config.dbType === 'mariadb' ? 'MARIADB' : 'MYSQL';
    envBlock = `
            - name: ${prefix}_DATABASE
              value: {{ .Values.database.name | quote }}
            - name: ${prefix}_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${config.dbPasswordKey}
{{- if ne .Values.database.user "root" }}
            - name: ${prefix}_USER
              value: {{ .Values.database.user | quote }}
            - name: ${prefix}_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${config.dbPasswordKey}
{{- end }}`;
    volumeMountPath = '/var/lib/mysql';
  } else if (config.dbType === 'mongodb') {
    envBlock = `
            - name: MONGO_INITDB_ROOT_USERNAME
              value: {{ .Values.database.user | quote }}
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${config.dbPasswordKey}
            - name: MONGO_INITDB_DATABASE
              value: {{ .Values.database.name | quote }}`;
    volumeMountPath = '/data/db';
  }

  envBlock += `
{{- if .Values.database.env }}
{{- range $key, $value := .Values.database.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}
{{- end }}`;

  return `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
  labels:
    app: {{ .Values.projectName }}
    component: database
spec:
  serviceName: database
  replicas: {{ include "flarops.replicas" .Values.database.replicas }}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: database
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: database
      annotations:
        # Rotating a value in GitHub Secrets rewrites the Secret object but
        # leaves running pods on the old value, because nothing about the
        # Deployment/StatefulSet itself changed. Hashing the secret material
        # into the pod template makes a rotation roll the pods.
        checksum/secret: {{ include "flarops.secretChecksum" (dict "password" ((.Values.database | default dict).password | default "")) }}
    spec:
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
{{- if .Values.dbCloneSource }}
      initContainers:
        - name: db-clone
          image: curlimages/curl:latest
          command: ["curl"]
          args: ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "-o", "/docker-entrypoint-initdb.d/dump.sql", "{{ .Values.dbCloneSource }}"]
          volumeMounts:
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- end }}
      containers:
        - name: db
          image: {{ if and .Values.werf .Values.werf.image.db }}{{ .Values.werf.image.db }}{{ else }}{{ .Values.images.db | default "db:latest" }}{{ end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
          env:${envBlock}${renderProbes(config.dbType, config.images && config.images.db)}
          resources:
            requests:
              memory: "256Mi"
              cpu: "200m"
            limits:
              memory: "1024Mi"
              cpu: "500m"
          volumeMounts:
            - name: data
              mountPath: ${volumeMountPath}
{{- if .Values.dbCloneSource }}
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- end }}
{{- if .Values.dbCloneSource }}
      volumes:
        - name: db-init
          emptyDir: {}
{{- end }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: {{ .Values.database.storage | default "10Gi" }}
`.trim();
};

// Shared with templates/generic/database.js so a per-service database gets
// exactly the same readiness semantics as the project's primary one.
module.exports.renderProbes = renderProbes;
