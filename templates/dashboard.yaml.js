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
  resources: ["nodes", "pods", "namespaces", "persistentvolumeclaims"]
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
{{- if eq .Values.werf.env "production" }}
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: flarops-node-agent
  labels:
    app: flarops-node-agent
spec:
  selector:
    matchLabels:
      app: flarops-node-agent
  template:
    metadata:
      labels:
        app: flarops-node-agent
    spec:
      automountServiceAccountToken: false
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
      tolerations:
        - operator: Exists
      containers:
        - name: node-agent
          image: {{ if .Values.werf }}{{ .Values.werf.image.dashboard }}{{ else }}{{ .Values.images.dashboard | default "dashboard:latest" }}{{ end }}
          env:
            - name: FLAROPS_NODE_AGENT
              value: "1"
            - name: FLAROPS_HOST_ROOT
              value: /host
          ports:
            - containerPort: 9101
              name: disk
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
            seccompProfile:
              type: RuntimeDefault
          volumeMounts:
            - name: host-root
              mountPath: /host
              readOnly: true
          resources:
            requests:
              memory: "16Mi"
              cpu: "5m"
            limits:
              memory: "64Mi"
              cpu: "50m"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 9101
            periodSeconds: 30
      volumes:
        - name: host-root
          hostPath:
            path: /
            type: Directory
{{- end }}
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
        checksum/secret: {{ include "flarops.secretChecksum" (dict "env" (.Values.env | default dict) "keys" (list "DASHBOARD_PASSWORD_HASH")) }}
    spec:
      serviceAccountName: flarops-dashboard
{{- if .Values.imagePullSecret }}
      imagePullSecrets:
        - name: {{ .Values.projectName }}-registry
{{- end }}
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
        - name: DASHBOARD_PASSWORD_HASH
          valueFrom:
            secretKeyRef:
              name: {{ .Values.projectName }}-secrets
              key: DASHBOARD_PASSWORD_HASH
        - name: DASHBOARD_TRUST_PROXY
          value: "1"
        - name: DOMAIN
          value: {{ .Values.domain | quote }}
        - name: DB_PATH
          value: "/data/flarops_metrics.db"
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
    kubernetes.io/ingress.class: traefik
spec:
  ingressClassName: traefik
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
