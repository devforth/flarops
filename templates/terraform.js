// Generates deploy/terraform/{main.tf,variables.tf}.
//
// Extracted from init.js because it is genuinely separable: it reads nine
// values from the operator's answers and writes two files, and nothing later
// in the generation reads anything it produces. It was 447 lines sitting in
// the middle of a 3000-line function, which is the single largest reason that
// function is hard to follow.

const fs = require('fs');
const path = require('path');

// Escapes a value for safe interpolation inside a double-quoted HCL string literal.
// Escapes a value for safe interpolation inside a double-quoted HCL string
// literal. Values here come from the operator's answers and from the scanned
// repository, so they can legally contain a quote, a backslash, or HCL's own
// "${" and "%{" interpolation markers.
function hclEscapeString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\$\{/g, '$${')
    .replace(/%\{/g, '%%{');
}

// writeTerraform is deliberately given writeFileIfNotExists rather than
// importing it: whether a file is preserved across re-runs is a policy the
// caller owns, not this module.
module.exports = function writeTerraform({
  projectName, domain, publicKey, awsRegion, remoteStateBucket, terraformDir,
  cloudflareApiToken, cloudflareZoneId, writeFileIfNotExists,
}) {


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
    # The state file contains the k3s join token and the deploy public key in
    # clear text, so it is encrypted at rest. use_lockfile is S3-native state
    # locking (Terraform 1.10+): without any lock, the three places that run
    # "terraform apply" - a push to main, a PR capsule scaling up, and one
    # scaling down - could interleave and corrupt the state.
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
  owners      = ["099720109477"] # Canonical

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

  # The instance metadata service hands out whatever is in user_data - which
  # includes the k3s join token. With IMDSv1 any process that can make an
  # outbound HTTP request could read it, so an SSRF in an application pod was
  # enough to take over the cluster. Requiring a session token (IMDSv2) blocks
  # the plain-GET SSRF shape, and a hop limit of 1 means the response never
  # survives the extra network hop out of a container - only the host itself
  # can reach it. Nothing in user_data queries the metadata service any more,
  # so requiring tokens costs nothing.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="\${var.k3s_version}" INSTALL_K3S_EXEC="server --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi --token \${random_password.k3s_token.result} --tls-san \${aws_eip.eip.public_ip}" sh -
  EOF
  )

  tags = {
    Name = var.instance_name
  }

  lifecycle {
    # user_data is ignored for the same reason as ami: cloud-init runs it only
    # on FIRST boot, so a change to it (bumping var.k3s_version, rotating the
    # deploy key) cannot take effect on a running instance - it only stops and
    # starts it, taking the cluster down for nothing. Applying a new k3s
    # version means replacing the node deliberately, not letting a plan do it
    # as a side effect: the whole cluster, including every local-path volume
    # holding the database, lives on this instance's root EBS.
    ignore_changes = [ami, user_data]
  }
}

# The Elastic IP is allocated BEFORE the server so its address can be baked
# into the API server certificate via --tls-san above. When the EIP was
# instead declared with "instance = aws_instance.server.id", k3s booted first
# and could only see the temporary auto-assigned public IP; the EIP attached
# afterwards, and every later "terraform output public_ip" returned an address
# the certificate did not cover, so kubectl failed with
# "x509: certificate is valid for <old-ip>". Association is a separate
# resource purely to keep the dependency pointing this way.
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

  # The instance metadata service hands out whatever is in user_data - which
  # includes the k3s join token. With IMDSv1 any process that can make an
  # outbound HTTP request could read it, so an SSRF in an application pod was
  # enough to take over the cluster. Requiring a session token (IMDSv2) blocks
  # the plain-GET SSRF shape, and a hop limit of 1 means the response never
  # survives the extra network hop out of a container - only the host itself
  # can reach it. Nothing in user_data queries the metadata service any more,
  # so requiring tokens costs nothing.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  user_data = sensitive(<<-EOF
    #!/bin/bash
    HOSTNAME="\${var.instance_name}-worker-\${each.key}"
    hostnamectl set-hostname $HOSTNAME

    mkdir -p /home/ubuntu/.ssh
    echo "\${var.ssh_public_key}" >> /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
    chmod 700 /home/ubuntu/.ssh
    chmod 600 /home/ubuntu/.ssh/authorized_keys

    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="\${var.k3s_version}" INSTALL_K3S_EXEC="agent --kubelet-arg=system-reserved=memory=256Mi --kubelet-arg=kube-reserved=memory=256Mi" K3S_URL=https://\${aws_instance.server.private_ip}:6443 K3S_TOKEN=\${random_password.k3s_token.result} sh -
  EOF
  )

  tags = {
    Name = "\${var.instance_name}-worker-\${each.key}"
    Role = "worker"
  }

  lifecycle {
    # user_data is ignored for the same reason as ami: cloud-init runs it only
    # on FIRST boot, so a change to it (bumping var.k3s_version, rotating the
    # deploy key) cannot take effect on a running instance - it only stops and
    # starts it, taking the cluster down for nothing. Applying a new k3s
    # version means replacing the node deliberately, not letting a plan do it
    # as a side effect: the whole cluster, including every local-path volume
    # holding the database, lives on this instance's root EBS.
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

# The instance shape is declared once, in variables.tf, and read back out
# here. CI feeds these outputs into the Helm values (see deploy.yml), which is
# what the dashboard prices the fleet against - so changing the instance type
# means editing exactly one line in variables.tf, not three files that can
# silently disagree about what is actually running.
# The slots currently provisioned. CI reads this instead of counting lines in
# "terraform state list", so scaling decisions are made against a real value
# Terraform itself reports rather than a grep over its output.
# Node names are derived from this, so CI must read it rather than rebuild it
# from the project name - they are only equal until someone edits the variable.
output "instance_name" {
  value = var.instance_name
}

output "worker_slots" {
  # Numbers, not strings. Terraform's sort() only takes a list of strings and
  # gives strings back, so sorting the numbers directly emitted ["1","3"] -
  # and the CI arithmetic that picks the next free slot then compared integers
  # against strings, found every slot "free", and handed back a number that
  # collided with a running worker.
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

# Workers are addressed by SLOT, not by position in a list.
#
# With "count", Terraform identifies an instance by its index, so removing a
# node in the middle renumbers every node above it - and reducing the count
# destroys the highest index, whichever node that happens to be. Reclaiming an
# idle worker while a busier one sits above it was therefore impossible, and
# the PR-capsule teardown could only ever peel nodes off the top.
#
# A set of slot numbers makes each worker independently addressable:
# dropping 2 from [1,2,3] destroys exactly worker 2 and leaves 1 and 3 alone.
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

# Pinned on purpose. "curl https://get.k3s.io | sh" without a version installs
# whatever is current the moment each node boots, so a fleet grown over weeks
# ends up running different Kubernetes versions, and a compromise of the
# install endpoint would land on every node that has yet to be created. Change
# it here and nowhere else - both the server and the agents read this.
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

  // variables.tf is deliberately preserved across re-runs so hand-tuned
  // instance_type/volume_size/aws_region survive - but "domain" is not a
  // tuning knob, it's the answer to a prompt this run just asked again.
  // Leaving the old value behind while values.yaml and both workflows get
  // the new one splits the stack in half: the Ingress serves the new host
  // while Cloudflare's DNS record still points the old one at the cluster,
  // which surfaces only as a 404 from an otherwise healthy deployment.
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
