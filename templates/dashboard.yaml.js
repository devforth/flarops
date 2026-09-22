module.exports = function dashboardYamlTemplate(config) {
  const domainParts = config.domain.split('.');
  const baseDomain = domainParts.length > 2 ? domainParts.slice(1).join('.') : config.domain;
  const dashboardDomain = `dashboard.${baseDomain}`;

  return `{{- if eq .Values.werf.env "production" }}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: flarops-dashboard
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ .Values.projectName }}-dashboard-role-{{ .Values.werf.env }}
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/proxy", "pods", "namespaces", "persistentvolumeclaims"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["metrics.k8s.io"]
  resources: ["nodes", "pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ .Values.projectName }}-dashboard-binding-{{ .Values.werf.env }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ .Values.projectName }}-dashboard-role-{{ .Values.werf.env }}
subjects:
- kind: ServiceAccount
  name: flarops-dashboard
  namespace: {{ .Release.Namespace }}
---
# configmaps are only ever read from the "default" namespace (see
# dashboard/collector.go's GetConfigMaps("default") call) - scoped to a
# namespaced Role instead of the cluster-wide ClusterRole above, so a
# compromised dashboard pod can't enumerate configmaps in every namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ .Values.projectName }}-dashboard-configmaps-{{ .Values.werf.env }}
  namespace: default
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ .Values.projectName }}-dashboard-configmaps-binding-{{ .Values.werf.env }}
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ .Values.projectName }}-dashboard-configmaps-{{ .Values.werf.env }}
subjects:
- kind: ServiceAccount
  name: flarops-dashboard
  namespace: {{ .Release.Namespace }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: flarops-dashboard-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: {{ .Values.dashboard.storage | default "1Gi" }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flarops-dashboard
spec:
  replicas: {{ include "flarops.replicas" .Values.dashboard.replicas }}
  selector:
    matchLabels:
      app: flarops-dashboard
  template:
    metadata:
      labels:
        app: flarops-dashboard
      annotations:
        # Rotating the dashboard credential rewrites the Secret but changes
        # nothing about this Deployment, so without this the pod kept running
        # on the old hash and the new password simply did not work until
        # someone deleted the pod by hand.
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (list "DASHBOARD_PASSWORD_HASH")) }}
    spec:
      serviceAccountName: flarops-dashboard
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: dashboard
        image: {{ .Values.werf.image.dashboard }}
        imagePullPolicy: Always
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        env:
        # The dashboard refuses to start without this (see loadAuthConfig in
        # dashboard/auth.go) rather than falling back to serving the cluster's
        # internals unauthenticated. Only the PBKDF2 hash travels here; the
        # password itself was shown once by "flarops init" and stored nowhere.
        - name: DASHBOARD_PASSWORD_HASH
          valueFrom:
            secretKeyRef:
              name: {{ .Values.projectName }}-secrets
              key: DASHBOARD_PASSWORD_HASH
        # Traefik terminates TLS and proxies to this pod, so the peer address
        # is the ingress controller and the real client is only in
        # X-Forwarded-For - which login rate limiting is keyed on.
        - name: DASHBOARD_TRUST_PROXY
          value: "1"
        - name: DOMAIN
          value: {{ .Values.domain | quote }}
        - name: DB_PATH
          value: "/data/flarops_metrics.db"
        # The cost model used to hardcode this project's own region, instance
        # type and root volume size, so spend was wrong for anyone running a
        # different shape. Pass the real values the infrastructure was
        # provisioned with instead.
        - name: AWS_REGION
          value: {{ .Values.aws.region | quote }}
        - name: FLAROPS_DEFAULT_INSTANCE_TYPE
          value: {{ .Values.aws.instanceType | default "" | quote }}
        - name: FLAROPS_EBS_GB
          value: {{ .Values.aws.volumeSize | default "" | quote }}
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: "64Mi"
            cpu: "50m"
          limits:
            memory: "256Mi"
            cpu: "500m"
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: flarops-dashboard-data
---
apiVersion: v1
kind: Service
metadata:
  name: flarops-dashboard
spec:
  selector:
    app: flarops-dashboard
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: flarops-dashboard
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web,websecure
    {{- if ${config.hasCloudflare ? 'true' : 'false'} }}
    kubernetes.io/ingress.class: traefik
    {{- else }}
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    {{- end }}
spec:
  ingressClassName: traefik
  {{- if not ${config.hasCloudflare ? 'true' : 'false'} }}
  tls:
  - hosts:
    - ${dashboardDomain}
    secretName: flarops-dashboard-tls
  {{- end }}
  rules:
  - host: ${dashboardDomain}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: flarops-dashboard
            port:
              number: 80
{{- end }}
`;
};
