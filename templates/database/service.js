module.exports = () => `
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
      port: {{ .Values.dbPort | default 5432 }}
      targetPort: {{ .Values.dbPort | default 5432 }}
`.trim();
