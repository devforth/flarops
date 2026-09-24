module.exports = (config) => {
  // config.dbPort is resolved per engine by the caller (see defaultPortFor in
  // utils/dbDefaults.js). The 5432 here is only the last resort for a chart
  // rendered with no database detected at all - it is NOT engine-aware, so do
  // not rely on it to be right for MongoDB or MySQL.
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
  # Deliberately a normal ClusterIP, NOT headless. Making it headless would
  # give the StatefulSet's "serviceName: database" the per-pod DNS name it
  # nominally wants, but spec.clusterIP is immutable once assigned, so every
  # already-deployed project would fail its next converge on "may not change
  # once set" - and a headless Service publishes no DNS records at all while
  # its pod is unready, which turns the readiness probe on the StatefulSet
  # (templates/database/deployment.js, concatenated after this file) into a hard
  # NXDOMAIN for every client during database startup instead of a retryable
  # refused connection. Nothing generated here addresses a database pod
  # individually, so the per-pod name buys nothing against those two costs.
  selector:
    app: {{ .Values.projectName }}
    component: database
  ports:
    - protocol: TCP
      port: {{ .Values.dbPort | default ${dbPort} }}
      targetPort: {{ .Values.dbPort | default ${dbPort} }}
`.trim();
};
