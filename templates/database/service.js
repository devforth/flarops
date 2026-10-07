const { defaultPortFor } = require('../../utils/dbDefaults.js');

// The port setting moves the address other pods use; the server itself keeps its engine's port.
module.exports = (config) => {
  const enginePort = defaultPortFor(config && config.dbType);
  const dbPort = (config && config.dbPort) || enginePort;

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
      targetPort: ${enginePort}
`.trim();
};
