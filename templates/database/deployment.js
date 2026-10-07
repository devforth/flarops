const { helmLiteral } = require('../generic/env.js');
// Postgres 18+ images manage a per-version layout under /var/lib/postgresql: mount one level up.
function getPostgresMajorVersion(image) {
  const tag = (image || '').split(':')[1] || '';
  const match = tag.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// Readiness: Running is not accepting connections.
function buildProbeCommand(dbType) {
  if (dbType === 'postgres' || dbType === 'postgresql') {
    // Through a shell: Kubernetes does not expand $(VAR) in probe commands.
    return ['sh', '-c', 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'];
  }
  if (dbType === 'mysql' || dbType === 'mariadb') {
    const passVar = dbType === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
    // mariadb-admin on MariaDB 11, mysqladmin on MySQL: resolved at runtime.
    return ['sh', '-c', `$(command -v mariadb-admin || command -v mysqladmin) ping -h 127.0.0.1 -u root -p"$${passVar}" --silent`];
  }
  if (dbType === 'mongodb') {
    // mongosh since MongoDB 6, mongo before.
    return ['sh', '-c', `(mongosh --quiet --eval 'db.adminCommand("ping")' || mongo --quiet --eval 'db.adminCommand("ping")')`];
  }
  return null;
}

function renderProbes(dbType, indent = '          ') {
  const cmd = buildProbeCommand(dbType);
  if (!cmd) return '';
  const asYaml = cmd.map(part => JSON.stringify(part)).join(', ');
  return `
${indent}startupProbe:
${indent}  exec:
${indent}    command: [${asYaml}]
${indent}  periodSeconds: 10
${indent}  timeoutSeconds: 5
${indent}  failureThreshold: 60
${indent}livenessProbe:
${indent}  exec:
${indent}    command: [${asYaml}]
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
{{- if and .Values.database.user (ne .Values.database.user "root") }}
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

  const initFiles = (config.dbInitFiles && Object.keys(config.dbInitFiles).length > 0)
    ? config.dbInitFiles : null;
  const initConfigMapName = 'database-initdb';
  let initConfigMap = '';
  if (initFiles) {
    initConfigMap = `
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${initConfigMapName}
  labels:
    app: {{ .Values.projectName }}
    component: database
data:
`;
    // Printed by Helm as text: seed data may hold "{{", and its first line may be indented.
    for (const [key, content] of Object.entries(initFiles)) {
      initConfigMap += `  ${helmLiteral(key)}: ${helmLiteral(content)}\n`;
    }
  }

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
        checksum/secret: {{ include "flarops.secretChecksum" (dict "password" ((.Values.database | default dict).password | default "")) }}
    spec:
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
{{- if .Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml .Values.dataNodeSelector | indent 8 }}
      tolerations:
        - key: flarops.io/capsule
          operator: Equal
          value: "true"
          effect: NoSchedule
{{- end }}
{{- if .Values.dbCloneSource }}
      initContainers:
        - name: db-clone
          image: curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777
          command: ["curl"]
          args: ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "-o", "/docker-entrypoint-initdb.d/dump.sql", "{{ .Values.dbCloneSource }}"]
          volumeMounts:
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- end }}
      containers:
        - name: db
          image: {{ if and .Values.werf .Values.werf.image.db }}{{ .Values.werf.image.db }}{{ else }}{{ .Values.images.db | default "db:latest" }}{{ end }}
{{- if (.Values.database | default dict).command }}
          args:
{{- range $arg := .Values.database.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
          env:${envBlock}${renderProbes(config.dbType)}
          volumeMounts:
            - name: data
              mountPath: ${volumeMountPath}${initFiles ? `
{{- if .Values.dbCloneSource }}
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- else }}
            - name: db-initdb
              mountPath: /docker-entrypoint-initdb.d
              readOnly: true
{{- end }}
      volumes:
{{- if .Values.dbCloneSource }}
        - name: db-init
          emptyDir: {}
{{- else }}
        - name: db-initdb
          configMap:
            name: ${initConfigMapName}
{{- end }}` : `
{{- if .Values.dbCloneSource }}
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- end }}
{{- if .Values.dbCloneSource }}
      volumes:
        - name: db-init
          emptyDir: {}
{{- end }}`}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: {{ .Values.database.storage | default "10Gi" }}
${initConfigMap}`.trim();
};

module.exports.renderProbes = renderProbes;
