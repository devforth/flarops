# Pinned to a patch release and its digest. A floating "golang:1.25" kept
# building on a Go line that left support in August 2026, and a bare tag means
# two builds of the same commit can use different toolchains. Bump both values
# together, deliberately.
FROM golang:1.27.1@sha256:e0174e51e81218523251d85d248a90d24c3d5e81543b4f07a5d66229397db190 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o dashboard .

FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
# curl is not decoration: the PR-capsule workflow asks this pod whether a new
# capsule fits by running "kubectl exec ... curl 127.0.0.1:9090/capacity"
# against the capacity oracle (see capacity.go), and exec runs with the image's
# own filesystem - a missing curl fails the check rather than answering it.
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 dashboard && useradd -u 10001 -g dashboard -M -s /usr/sbin/nologin dashboard

WORKDIR /app
COPY --from=builder /app/dashboard .
RUN chown dashboard:dashboard /app/dashboard

USER 10001:10001

EXPOSE 8080
# 9090 is the capacity oracle. It is bound to loopback and deliberately has no
# Service, so this is documentation of the port, not an exposure of it.
EXPOSE 9090
CMD ["./dashboard"]
