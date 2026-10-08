const { renderVolumes } = require('../generic/volumes.js');
const { secretRefs, urlEncodedRef, alreadyEmitted } = require('../generic/env.js');
const { dbUrlScheme } = require('../../utils/dbDefaults.js');
module.exports = (config) => {
  const extraSecretEnvBlock = secretRefs(config.apiExtraSecretEnvMappings, '.');
  const hasExtraSecretEnv = extraSecretEnvBlock.length > 0;
  // Keys rendered directly must be named for the checksum, or rotating them would not roll the pod.
  const quoteKeys = (keys) => keys.filter(Boolean).map(k => JSON.stringify(k)).join(' ');
  const apiExtraKeyList = quoteKeys([
    ...(config.apiExtraSecretEnvMappings || []).map(m => m.secretKey),
    config.dbPasswordKey,
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

    // The encoded twin must come before the URLs: $(VAR) expands only against earlier entries.
    dbUrlEnvBlock += urlEncodedRef(config.dbPasswordKey, '.');

    for (const urlVar of config.dbUrlVars) {
      // Read from the project's own URL: nothing in it may open a Helm action or end the YAML string.
      let query = String(urlVar.query || '').replace(/[{}"\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      if (scheme === 'mongodb' && !query.includes('authSource')) {
        query += query ? '&' + mongoAuth.slice(1) : mongoAuth;
      }

      dbUrlEnvBlock += `
            - name: ${urlVar.key}
              value: "${dbUrlScheme(config.dbType, urlVar.scheme)}://{{ include "flarops.urlencode" .Values.database.user }}:$(${config.dbPasswordKey}_URLENCODED)@database:{{ .Values.dbPort | default ${defaultPort} }}/{{ include "flarops.urlencode" .Values.database.name }}${query}"`;
    }
  }

  let hasCustomEnv = config.dbUrlVars && config.dbUrlVars.length > 0;

  const hasDbPassword = !!config.hasDbPassword;
  // "Already emitted" under this env name by any mechanism: a duplicate is rejected by the API server.
  const dbPasswordAlreadyEmitted = alreadyEmitted(config.apiSecretKeys, config.apiExtraSecretEnvMappings, config.dbPasswordKey);
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

  // A migration step runs as an initContainer; checkFile gates it so a wrong guess is a no-op.
  const apiArgsBlock = `
{{- if .Values.api.command }}
          args:
{{- range $arg := .Values.api.command }}
            - {{ $arg | quote }}
{{- end }}
{{- end }}`;

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

  const { pvcs, volumeMounts, volumes } = renderVolumes({ name: 'api', volumes: config.apiVolumes }, { mountIndent: 12, volumeIndent: 8 });

  return `${pvcs}${pvcs ? '---\n' : ''}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app: {{ .Values.projectName }}
    component: api
spec:
  replicas: {{ include "flarops.replicas" .Values.api.replicas }}${volumes ? `
  strategy:
    type: Recreate` : ''}
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
{{- if $.Values.dataNodeSelector }}
      nodeSelector:
{{ toYaml $.Values.dataNodeSelector | indent 8 }}
      tolerations:
        - key: flarops.io/capsule
          operator: Equal
          value: "true"
          effect: NoSchedule
{{- end }}
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
{{- if .Values.api.healthRoute }}
          startupProbe:
            httpGet:
              path: {{ .Values.api.healthRoute }}
              port: {{ .Values.api.healthPort | default (index .Values.apiPorts 0) | default 3000 }}
            periodSeconds: 10
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
{{- end }}${volumeMounts ? `
          volumeMounts:${volumeMounts}` : ''}${volumes ? `
      volumes:${volumes}` : ''}
`.trim();
};
