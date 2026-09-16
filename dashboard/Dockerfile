FROM golang:1.25 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o dashboard .

FROM ubuntu:22.04
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 dashboard && useradd -u 10001 -g dashboard -M -s /usr/sbin/nologin dashboard

WORKDIR /app
COPY --from=builder /app/dashboard .
RUN chown dashboard:dashboard /app/dashboard

USER 10001:10001

EXPOSE 8080
CMD ["./dashboard"]
