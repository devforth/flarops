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
      containers:
        - name: api
          image: {{ if .Values.werf }}{{ .Values.werf.image.api }}{{ else }}{{ .Values.images.api | default "api:latest" }}{{ end }}
{{- if .Values.env }}
          envFrom:
            - secretRef:
                name: {{ .Values.projectName }}-secrets
{{- end }}
{{- if or .Values.api.env ${hasCustomEnv ? 'true' : 'false'} }}
          env:
{{- range $key, $value := .Values.api.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
{{- end }}${dbUrlEnvBlock}
{{- if .Values.database }}
            - name: {{ "${config.dbPasswordKey}" }}
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectName }}-secrets
                  key: {{ "${config.dbPasswordKey}" }}
{{- end }}
{{- end }}
          resources:
            requests:
              memory: "256Mi"
              cpu: "500m"
            limits:
              memory: "512Mi"
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
