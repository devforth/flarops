module.exports = (config) => {
  let dbUrlEnvBlock = '';
  if (config.dbUrlVars && config.dbUrlVars.length > 0 && config.dbType) {
    let scheme = 'postgres';
    if (config.dbType === 'mysql' || config.dbType === 'mariadb') scheme = 'mysql';
    else if (config.dbType === 'mongodb') scheme = 'mongodb';

    for (const urlVar of config.dbUrlVars) {
      dbUrlEnvBlock += `
            - name: ${urlVar.key}
              value: "${scheme}://{{ .Values.database.user }}:$(${config.dbPasswordKey})@database:{{ .Values.dbPort | default 5432 }}/{{ .Values.database.name }}${urlVar.query}"`;
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
{{- end }}
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "500m"
`.trim();
};
