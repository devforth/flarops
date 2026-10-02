module.exports = (config) => {
  const dbPort = (config && config.dbPort) || 5432;

  return `
apiVersion: v1
kind: Service
metadata:
  name: database
  labels:
    app: {{ .Values.projectName }}
    component: database
spec:
  selector:
    app: {{ .Values.projectName }}
    component: database
  ports:
    - protocol: TCP
      port: {{ .Values.dbPort | default ${dbPort} }}
      targetPort: {{ .Values.dbPort | default ${dbPort} }}
`.trim();
};
