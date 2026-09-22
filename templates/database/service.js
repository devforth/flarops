module.exports = (config) => {
  // The port has to be the engine's own default, not Postgres' - a MongoDB
  // project whose dbPort ended up unset used to get a Service on 5432 in
  // front of a container listening on 27017.
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
  # its pod is unready, which turns the readiness probe above into a hard
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
