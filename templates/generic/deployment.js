const { renderVolumes } = require('./volumes.js');
const { secretRefs, urlEncodedRef, alreadyEmitted } = require('./env.js');
const { dbUrlScheme } = require('../../utils/dbDefaults.js');

// Encodes values known at generation time; the password is encoded in the Secret (flarops.urlencode).
const urlComponent = (value) => encodeURIComponent(String(value === undefined || value === null ? '' : value));

module.exports = (service) => {
  const { pvcs, volumeMounts, volumes } = renderVolumes(service, { mountIndent: 12, volumeIndent: 8 });
  // A ReadWriteOnce claim deadlocks a rolling update: Recreate.
  const strategyBlock = volumes ? `
  strategy:
    type: Recreate` : '';

  // Skip the DB password block when the same env name is already emitted - duplicates are rejected.
  const dbPasswordAlreadyEmitted = alreadyEmitted(service.secretKeys, service.extraSecretEnvMappings, service.dbPasswordKey);
  const dbPasswordBlock = (service.dbPasswordKey && !dbPasswordAlreadyEmitted) ? `
            - name: ${service.dbPasswordKey}
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.dbPasswordKey}` : '';

  const springDatasourcePasswordBlock = service.springDatasourcePasswordSecretKey ? `
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ $.Values.projectName }}-secrets
                  key: ${service.springDatasourcePasswordSecretKey}` : '';

  let ownDbUrlBlock = '';
  if (service.db && Array.isArray(service.dbUrlVars) && service.dbUrlVars.length > 0) {
    const db = service.db;
    const dbHost = db.shared ? 'database' : `${service.name}-db`;
    let scheme = 'postgres';
    if (db.type === 'mysql' || db.type === 'mariadb') scheme = 'mysql';
    else if (db.type === 'mongodb') scheme = 'mongodb';
    const authSuffix = scheme === 'mongodb' ? '?authSource=admin' : '';
    // The encoded twin must come before the URLs: $(VAR) expands only against earlier entries.
    if (db.passwordKey) {
      ownDbUrlBlock += urlEncodedRef(db.passwordKey);
    }
    for (const urlVar of service.dbUrlVars) {
      const dbName = urlVar.dbName || db.name;
      const dbPath = dbName ? urlComponent(dbName) : '{{ include "flarops.urlencode" .Values.database.name }}';
      ownDbUrlBlock += `
            - name: ${urlVar.key}
              value: "${dbUrlScheme(db.type, urlVar.scheme)}://${urlComponent(db.user)}:$(${db.passwordKey}_URLENCODED)@${dbHost}:${db.port}/${dbPath}${authSuffix}"`;
    }
  }

  const extraSecretEnvBlock = secretRefs(service.extraSecretEnvMappings);

  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const extraKeyList = [
    ...(service.extraSecretEnvMappings || []).map(m => m.secretKey),
    service.dbPasswordKey,
    service.springDatasourcePasswordSecretKey,
  ].filter(Boolean).map(k => JSON.stringify(k)).join(' ');

  return `${pvcs}apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${service.name}
  labels:
    app: {{ .Values.projectName }}
    component: ${service.name}
spec:
  replicas: {{ include "flarops.replicas" (index .Values.additionalServices (index .Values.additionalServicesIndices "${service.name}" | int)).replicas }}${strategyBlock}
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
{{- if $.Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml $.Values.dataNodeSelector | indent 8 }}
{{- end }}
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
{{- if or $serviceObj.env $serviceObj.secretKeys ${service.dbPasswordKey ? 'true' : 'false'} ${service.springDatasourcePasswordSecretKey ? 'true' : 'false'} ${(Array.isArray(service.extraSecretEnvMappings) && service.extraSecretEnvMappings.length > 0) ? 'true' : 'false'} ${ownDbUrlBlock ? 'true' : 'false'} }}
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
{{- if $serviceObj.healthRoute }}
          startupProbe:
            httpGet:
              path: {{ $serviceObj.healthRoute }}
              port: {{ $serviceObj.healthPort | default (index $serviceObj.ports 0) | default 80 }}
            periodSeconds: 10
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
{{- end }}${volumeMounts ? `
          volumeMounts:${volumeMounts}` : ''}${volumes ? `
      volumes:${volumes}` : ''}
`.trim();
};
