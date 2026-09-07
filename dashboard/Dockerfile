FROM golang:1.25 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -a -installsuffix cgo -o dashboard .

FROM ubuntu:22.04
RUN apt-get update && apt-get install -y ca-certificates unzip curl git && rm -rf /var/lib/apt/lists/*

# Install Terraform
RUN curl -O https://releases.hashicorp.com/terraform/1.5.7/terraform_1.5.7_linux_amd64.zip && \
    unzip terraform_1.5.7_linux_amd64.zip -d /usr/local/bin/ && \
    rm terraform_1.5.7_linux_amd64.zip

WORKDIR /app
COPY --from=builder /app/dashboard .

EXPOSE 8080
CMD ["./dashboard"]
