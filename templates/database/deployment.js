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
                  key: DATABASE_PASSWORD
            - name: POSTGRES_DB
              value: {{ .Values.database.name | quote }}`;
    volumeMountPath = '/var/lib/postgresql/data';
  } else if (config.dbType === 'mysql') {
    envBlock = `
            - name: MYSQL_DATABASE
              value: {{ .Values.database.name | quote }}
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: DATABASE_PASSWORD
{{- if ne .Values.database.user "root" }}
            - name: MYSQL_USER
              value: {{ .Values.database.user | quote }}
            - name: MYSQL_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: DATABASE_PASSWORD
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
                  key: DATABASE_PASSWORD
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
  replicas: 1
  selector:
    matchLabels:
      app: {{ .Values.projectName }}
      component: database
  template:
    metadata:
      labels:
        app: {{ .Values.projectName }}
        component: database
    spec:
{{- if .Values.dbCloneSource }}
      initContainers:
        - name: db-clone
          image: curlimages/curl:latest
          command: ["/bin/sh", "-c"]
          args: ["curl -s -L -o /docker-entrypoint-initdb.d/dump.sql {{ .Values.dbCloneSource }}"]
          volumeMounts:
            - name: db-init
              mountPath: /docker-entrypoint-initdb.d
{{- end }}
      containers:
        - name: db
          image: {{ if and .Values.werf .Values.werf.image.db }}{{ .Values.werf.image.db }}{{ else }}{{ .Values.images.db | default "db:latest" }}{{ end }}
          env:${envBlock}
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
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
            storage: 10Gi
`.trim();
};
