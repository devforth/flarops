// Same layout concern as templates/database/deployment.js: Postgres 18+
// needs its volume mounted one level up (/var/lib/postgresql, not
// .../data) so the image can manage its own version-specific subdirectory.
// See https://github.com/docker-library/postgres/pull/1259.
function getPostgresMajorVersion(image) {
  const tag = (image || '').split(':')[1] || '';
  const match = tag.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// A dedicated database for one additional service (e.g. a Java service on
// MySQL alongside a Node service on MongoDB) - mirrors
// templates/database/deployment.js, but named after and scoped to this one
// service instead of being the project's single shared "database".
const { renderProbes } = require('../database/deployment.js');

module.exports = (service) => {
  const db = service.db;
  const resourceName = `${service.name}-db`;

  let envBlock = '';
  let volumeMountPath = '/var/lib/data';

  if (db.type === 'postgres' || db.type === 'postgresql') {
    envBlock = `
            - name: POSTGRES_USER
              value: {{ $svcDb.user | quote }}
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${db.passwordKey}
            - name: POSTGRES_DB
              value: {{ $svcDb.name | quote }}`;
    const pgMajorVersion = getPostgresMajorVersion(db.image);
    volumeMountPath = (pgMajorVersion && pgMajorVersion >= 18) ? '/var/lib/postgresql' : '/var/lib/postgresql/data';
  } else if (db.type === 'mysql' || db.type === 'mariadb') {
    const prefix = db.type === 'mariadb' ? 'MARIADB' : 'MYSQL';
    envBlock = `
            - name: ${prefix}_DATABASE
              value: {{ $svcDb.name | quote }}
            - name: ${prefix}_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${db.passwordKey}
{{- if ne $svcDb.user "root" }}
            - name: ${prefix}_USER
              value: {{ $svcDb.user | quote }}
            - name: ${prefix}_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${db.passwordKey}
{{- end }}`;
    volumeMountPath = '/var/lib/mysql';
  } else if (db.type === 'mongodb') {
    envBlock = `
            - name: MONGO_INITDB_ROOT_USERNAME
              value: {{ $svcDb.user | quote }}
            - name: MONGO_INITDB_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: ${db.passwordKey}
            - name: MONGO_INITDB_DATABASE
              value: {{ $svcDb.name | quote }}`;
    volumeMountPath = '/data/db';
  }

  return `
{{- $svcDb := (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).db }}
apiVersion: v1
kind: Service
metadata:
  name: ${resourceName}
  labels:
    app: {{ .Values.projectName }}
    component: ${resourceName}
spec:
  # A normal ClusterIP, for the reasons set out in templates/database/service.js:
  # clusterIP is immutable, and a headless Service resolves to nothing at all
  # while its pod is unready.
  selector:
    app: {{ .Values.projectName }}
    component: ${resourceName}
  ports:
    - protocol: TCP
      port: {{ $svcDb.port }}
      targetPort: {{ $svcDb.port }}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${resourceName}
  labels:
    app: {{ .Values.projectName }}
    component: ${resourceName}
spec:
  serviceName: ${resourceName}
  replicas: {{ include "flarops.replicas" $svcDb.replicas }}
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: ${resourceName}
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: ${resourceName}
      annotations:
        checksum/secret: {{ include "flarops.secretChecksum" (dict "password" ((.Values.database | default dict).password | default "")) }}
    spec:
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
      containers:
        - name: db
          image: {{ $svcDb.image }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["NET_RAW"]
            seccompProfile:
              type: RuntimeDefault
          env:${envBlock}${renderProbes(db.type, db.image)}
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
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: {{ $svcDb.storage | default "10Gi" }}
`.trim();
};
