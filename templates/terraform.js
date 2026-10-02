// Generates deploy/terraform/{main.tf,variables.tf}.

const fs = require('fs');
const path = require('path');

// Escapes a value for a double-quoted HCL string, including HCL's own ${ and %{.
function hclEscapeString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\$\{/g, '$${')
    .replace(/%\{/g, '%%{');
}

module.exports = function writeTerraform({
  projectName, domain, publicKey, awsRegion, remoteStateBucket, terraformDir,
  cloudflareApiToken, cloudflareZoneId, writeFileIfNotExists,
}) {

  // The head of both bootstrap scripts. Indented four spaces: it sits inside a <<-EOF heredoc.
  const bootstrapPreamble = `    exec > >(tee -a /var/log/flarops-bootstrap.log) 2>&1
    set -Eeuo pipefail

    mkdir -p /var/lib/flarops
    trap 'echo "flarops: bootstrap FAILED at line $LINENO"' ERR
    trap 'flarops_rc=$?; if [ "$flarops_rc" != 0 ]; then touch /var/lib/flarops/bootstrap-failed; fi' EXIT
`;

  const installerDownload = `    K3S_INSTALLER_URLS="https://raw.githubusercontent.com/k3s-io/k3s/\${var.k3s_version}/install.sh https://get.k3s.io"

    downloaded=""
    for attempt in $(seq 1 5); do
      for url in $K3S_INSTALLER_URLS; do
        if curl -fsSL --retry 3 --retry-delay 5 --retry-connrefused --max-time 180 \\
             -o /tmp/k3s-install.sh "$url" && [ -s /tmp/k3s-install.sh ]; then
          echo "flarops: got the k3s installer from $url"
          downloaded=yes
          break
        fi
        echo "flarops: $url did not serve the installer"
      done
      if [ -n "$downloaded" ]; then break; fi
      echo "flarops: no source served the k3s installer (attempt $attempt/5)"
      if [ "$attempt" = 5 ]; then exit 1; fi
      sleep 15
    done
    test -s /tmp/k3s-install.sh
`;

  const cloudflareProviderConfig = cloudflareApiToken && cloudflareZoneId ? `
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
` : '';

  const mainTfContent = `terraform {
  backend "s3" {
    bucket = "${remoteStateBucket}"
    key    = "terraform.tfstate"
    region = "${awsRegion}"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
${cloudflareProviderConfig}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags = {
    Name = "\${var.instance_name}-vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "\${var.aws_region}a"
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "random_password" "k3s_token" {
  length  = 32
  special = false
}

resource "aws_security_group" "sg" {
  name        = "\${var.instance_name}-sg"
  description = "Allow SSH, HTTP, and Kubernetes API"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Intra-cluster communication"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Kubernetes API"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-*-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.sg.id]

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
${bootstrapPreamble}
    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

${installerDownload}
    echo "flarops: installing k3s server \${var.k3s_version}"
    INSTALL_K3S_VERSION="\${var.k3s_version}" \\
      K3S_TOKEN="\${random_password.k3s_token.result}" \\
      INSTALL_K3S_EXEC="server --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi --tls-san \${aws_eip.eip.public_ip}" \\
      sh /tmp/k3s-install.sh

    for attempt in $(seq 1 60); do
      if [ -f /etc/rancher/k3s/k3s.yaml ]; then break; fi
      sleep 5
    done
    test -f /etc/rancher/k3s/k3s.yaml

    echo "flarops: bootstrap OK"
    touch /var/lib/flarops/bootstrap-ok
  EOF
  )

  tags = {
    Name = var.instance_name
  }

  lifecycle {
    # Changes to the AMI or to user_data reach only new instances; replace this
    # one deliberately (terraform apply -replace=...) to apply them here. The
    # cluster's data lives on its root volume.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "eip" {
  domain = "vpc"
}

resource "aws_eip_association" "eip_assoc" {
  instance_id   = aws_instance.server.id
  allocation_id = aws_eip.eip.id
}

resource "aws_instance" "worker" {
  for_each               = toset([for slot in var.worker_slots : tostring(slot)])
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.sg.id]

  root_block_device {
    volume_size = var.volume_size
    volume_type = "gp3"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
${bootstrapPreamble}
    HOSTNAME="\${var.instance_name}-worker-\${each.key}"
    hostnamectl set-hostname $HOSTNAME

    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

${installerDownload}
    echo "flarops: installing k3s agent \${var.k3s_version}"
    INSTALL_K3S_VERSION="\${var.k3s_version}" \\
      K3S_URL="https://\${aws_instance.server.private_ip}:6443" \\
      K3S_TOKEN="\${random_password.k3s_token.result}" \\
      INSTALL_K3S_EXEC="agent --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi" \\
      sh /tmp/k3s-install.sh

    for attempt in $(seq 1 60); do
      if systemctl is-active --quiet k3s-agent; then break; fi
      sleep 5
    done
    systemctl is-active --quiet k3s-agent

    echo "flarops: bootstrap OK"
    touch /var/lib/flarops/bootstrap-ok
  EOF
  )

  tags = {
    Name = "\${var.instance_name}-worker-\${each.key}"
    Role = "worker"
  }

  lifecycle {
    # Changes to the AMI or to user_data reach only new instances; replace this
    # one deliberately (terraform apply -replace=...) to apply them here. The
    # cluster's data lives on its root volume.
    ignore_changes = [ami, user_data]
  }
}
`;

  const cloudflareResourceBlock = cloudflareApiToken && cloudflareZoneId ? `
resource "cloudflare_record" "domain" {
  count   = var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  value   = aws_eip.eip.public_ip
  type    = "A"
  proxied = true
}

resource "cloudflare_record" "wildcard" {
  count   = var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "*"
  value   = aws_eip.eip.public_ip
  type    = "A"
  proxied = true
}
` : '';

  const mainTfContentEnd = `
output "public_ip" {
  value = aws_eip.eip.public_ip
}

output "instance_name" {
  value = var.instance_name
}

output "worker_slots" {
  value = [for s in sort([for x in var.worker_slots : tostring(x)]) : tonumber(s)]
}

output "worker_nodes" {
  description = "Kubernetes node names of the workers, derived from the same values that set their hostnames."
  value       = sort([for slot in var.worker_slots : "\${var.instance_name}-worker-\${slot}"])
}

output "instance_type" {
  value = var.instance_type
}

output "volume_size" {
  value = var.volume_size
}
${cloudflareResourceBlock}`;

  const finalMainTfContent = mainTfContent + mainTfContentEnd;

  const cloudflareVarsBlock = cloudflareApiToken && cloudflareZoneId ? `
variable "cloudflare_api_token" {
  description = "Cloudflare API Token"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID"
  type        = string
  default     = ""
}
` : '';

  const variablesTfContent = `variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "${awsRegion}"
}

variable "instance_name" {
  description = "Name tag for the EC2 instance"
  type        = string
  default     = "${projectName}-instance"
}

# Worker nodes, by slot number. The PR-capsule workflow adds and removes them;
# there is no need to edit this by hand.
variable "worker_slots" {
  description = "Slot numbers of the worker nodes to run, e.g. [1,3]. Each slot is one instance, addressable independently of the others."
  type        = set(number)
  default     = []
}

variable "instance_type" {
  description = "Type of the instance"
  type        = string
  default     = "t3a.medium"
}

# Read by the server and every worker. A change applies to NEW nodes only -
# replace an existing one (terraform apply -replace=...) to upgrade it.
variable "k3s_version" {
  description = "k3s version installed on every node (see https://github.com/k3s-io/k3s/releases)"
  type        = string
  default     = "v1.36.4+k3s1"
}

variable "volume_size" {
  description = "Size of the root volume in GB"
  type        = number
  default     = 40
}

variable "ssh_public_key" {
  description = "Public SSH key for EC2 instance"
  type        = string
  default     = "${hclEscapeString(publicKey)}"
  sensitive   = true
}
${cloudflareVarsBlock}
variable "domain" {
  description = "Domain Name"
  type        = string
  default     = "${hclEscapeString(domain)}"
}
`;

  const mainTfFile = path.join(terraformDir, 'main.tf');
  writeFileIfNotExists(mainTfFile, finalMainTfContent, "Created deploy/terraform/main.tf", "deploy/terraform/main.tf already exists and is not empty");

  const variablesTfFile = path.join(terraformDir, 'variables.tf');
  const variablesTfExisted = fs.existsSync(variablesTfFile) && fs.readFileSync(variablesTfFile, 'utf8').trim() !== '';
  writeFileIfNotExists(variablesTfFile, variablesTfContent, "Created deploy/terraform/variables.tf", "deploy/terraform/variables.tf already exists");

  // variables.tf is preserved across re-runs, but the domain follows the latest answer.
  if (variablesTfExisted) {
    try {
      const existing = fs.readFileSync(variablesTfFile, 'utf8');
      const domainVarRegex = /(variable\s+"domain"\s*\{[\s\S]*?default\s*=\s*")([^"]*)(")/;
      const found = existing.match(domainVarRegex);
      if (found && found[2] !== domain) {
        fs.writeFileSync(variablesTfFile, existing.replace(domainVarRegex, `$1${hclEscapeString(domain)}$3`));
        console.log(`\x1b[34mINFO: Updated domain in deploy/terraform/variables.tf ("${found[2]}" -> "${domain}"). Re-run the deploy workflow so the DNS record is recreated for the new domain.\x1b[0m`);
      }
    } catch (e) {
      console.warn(`\x1b[33mWARNING: Could not update the domain in deploy/terraform/variables.tf - check its "domain" variable still matches "${domain}".\x1b[0m`);
    }
  }
};

module.exports.hclEscapeString = hclEscapeString;
