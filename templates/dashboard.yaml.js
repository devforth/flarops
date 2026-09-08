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
  name: flarops-dashboard-role-{{ .Values.werf.env }}
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/proxy", "pods", "namespaces", "configmaps", "persistentvolumeclaims"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["metrics.k8s.io"]
  resources: ["nodes", "pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: flarops-dashboard-binding-{{ .Values.werf.env }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: flarops-dashboard-role-{{ .Values.werf.env }}
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
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flarops-dashboard
spec:
  replicas: 1
  selector:
    matchLabels:
      app: flarops-dashboard
  template:
    metadata:
      labels:
        app: flarops-dashboard
    spec:
      serviceAccountName: flarops-dashboard
      containers:
      - name: dashboard
        image: {{ .Values.werf.image.dashboard }}
        imagePullPolicy: Always
        env:
        - name: DOMAIN
          value: {{ .Values.domain | quote }}
        - name: DB_PATH
          value: "/data/flarops_metrics.db"
        ports:
        - containerPort: 8080
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
