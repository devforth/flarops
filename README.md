# Flarops

Flarops is a DevOps CLI that reads your repository and generates the whole deployment stack for it: a Kubernetes Helm chart, Terraform infrastructure on AWS, Werf build manifests, GitHub Actions pipelines, and a fleet dashboard.

One command produces a deployment you can read, edit and commit. Nothing is hidden behind a service.

## Features

- **Project analyzer.** Detects your frontend (React, Vue, Vite, Next, …), backends (Node, Python, Go, Java, PHP, Ruby, .NET), databases (PostgreSQL, MySQL, MariaDB, MongoDB), and the routes each service exposes. Reads `docker-compose.yml` as the authoritative inventory when you have one.
- **Multi-service support.** Every service docker-compose builds becomes its own Deployment, including several services sharing one build context. Third-party components you depend on but do not build (Redis, RabbitMQ, Keycloak, …) are generated from their compose declaration, with their configuration files carried into the cluster as ConfigMaps.
- **API gateway awareness.** If one of your services is the edge (`gateway-service`, `api-gateway`, a BFF), the services behind it are kept off the public Ingress so the gateway cannot be bypassed.
- **Helm chart.** Deployments, StatefulSets with PVCs, Services, Traefik Ingress, secrets wired from CI, health probes derived from your actual health routes.
- **Terraform.** A k3s cluster on EC2 with remote state in S3 (versioned, encrypted, public access blocked), IMDSv2 required, and worker nodes that can be added and reclaimed individually.
- **PR capsules.** Every pull request gets its own namespace, domain and database clone, placed on a node that has been measured to have room for it, and torn down when the PR closes.
- **Fleet dashboard.** A password-protected dashboard showing nodes, capsules, memory allocation and running spend — and answering the placement question the PR pipeline asks.

## Installation

```bash
npm install -g flarops
```

Or, to work on Flarops itself, from its directory:

```bash
npm link
```

## Usage

From the root of your application repository (it must be a Git repository):

```bash
flarops init
```

Flarops analyzes the repository, asks for the credentials it cannot discover, and writes the deployment files. Follow `FLAROPS.md`, which it generates, to deploy for the first time.

## What `flarops init` asks you

### Values it collects

None of these change anything on their own — they are written into the generated configuration.

| Prompt | Notes |
| --- | --- |
| `Enter docker registry` | Leave empty for Docker Hub. |
| `Enter username for <registry>` | |
| `Enter password for <registry>` | Hidden. Used immediately for `docker login`, then stored in `deploy/.env`. |
| `Enter project domain` | Press Enter to deploy without a domain. |
| `Enter Cloudflare API Token` | Only if you enabled Cloudflare DNS. Hidden. |
| `Enter Cloudflare Zone ID` | Only if you enabled Cloudflare DNS. |
| `Enter project AWS Access Key ID` | Press Enter to use your default `~/.aws/credentials`. |
| `Enter project AWS Secret Access Key` | Hidden. Only asked if you entered an Access Key ID. |
| `Enter AWS region` | Press Enter for `us-west-2`. |
| `Enter new bucket name` | Only if the Terraform state bucket name is taken or invalid. |

### Confirmation that changes what gets provisioned

| Prompt | What it changes |
| --- | --- |
| `Do you want to configure Cloudflare DNS for this domain automatically? [Y/n]` | **Defaults to yes.** Adds Cloudflare DNS records for your domain and its wildcard to the Terraform configuration, so deploys point the domain at the cluster for you. Requires an API token and Zone ID, which it asks for next. Answer `n` to manage DNS yourself. |

### Confirmations that modify your source code

**These default to yes.** Pressing Enter accepts them, and they rewrite files in your repository — not in `deploy/`. Commit or stash your work before running `init` if you want to be able to review or undo the changes.

| Prompt | What it changes |
| --- | --- |
| `Do you want to automatically refactor hardcoded frontend API URLs to environment variables? [Y/n]` | Replaces hardcoded API URLs in your frontend source with environment variable reads. |
| `Do you want to automatically refactor hardcoded database URLs in the backend to environment variables? [Y/n]` | Replaces hardcoded database connection strings in your backend source. |
| `Found lowercase environment variables in backend code (…). Do you want to automatically refactor them? [Y/n]` | Renames the listed variables to UPPERCASE in your backend source and in your `.env` files. |

Answer `n` to any of them to leave your source untouched. Flarops still generates a complete deployment — you then wire those values yourself.

### Confirmation that reuses cloud resources

| Prompt | Notes |
| --- | --- |
| `Bucket [name] is already exist, are you sure you want to use it? [y/N]` | **Defaults to no.** An S3 bucket with the derived name already exists in your account. Answering yes stores this project's Terraform state in it; answering no lets you pick another name. This is the one prompt where Enter declines, because agreeing by reflex could put your state in a bucket that belongs to something else. |

### What happens without asking

Worth knowing before the first run:

- **Writes `deploy/`, `werf.yaml`, `werf-giterminism.yaml` and `FLAROPS.md`**, overwriting them if they exist. Everything under `deploy/` is regenerated on every run, so hand edits there do not survive — change `deploy/helm/values.yaml` for configuration instead.
- **Generates an SSH key pair in `.keys/`** if there is none, and appends `.env`, `.keys/`, and Terraform artefacts to your `.gitignore`. A key that is already tracked by Git stops the run with instructions, rather than being reused.
- **Runs `docker login`** against the registry with the credentials you entered, to verify them.
- **Creates the Terraform state S3 bucket** if it does not exist, with versioning, encryption and public access blocking enabled. You are only asked when a bucket with that name already exists.
- **Generates a dashboard password**, shows it once, and stores only its PBKDF2 hash. It is not recoverable — save it when it is shown.
- **Creates `.dockerignore`** if any service builds from the repository root, to keep `deploy/`, `.env` and `.keys/` out of your images.

Flarops prints warnings for anything it could not resolve — unset variables, ambiguous Ingress paths, files it could not carry into the cluster. Read them: they are the parts of the deployment that need your attention before it will work.

## Generated structure

```text
.
├── deploy/
│   ├── helm/                   # Kubernetes Helm chart
│   │   ├── templates/          # One file per service, plus ingress and secrets
│   │   └── values.yaml         # The file you edit to configure the deployment
│   ├── terraform/              # AWS infrastructure (k3s on EC2, S3 remote state)
│   ├── dashboard/              # Fleet dashboard source, built and deployed with the app
│   ├── .env                    # Secrets to copy into GitHub repository secrets
│   └── .env.safety             # Internal deploy configuration
├── .github/workflows/
│   ├── deploy.yml              # Provision infrastructure and deploy on push to main
│   └── pr-capsule.yml          # Per-PR environment, created and torn down automatically
├── .keys/                      # Deploy SSH key pair (gitignored)
├── werf.yaml                   # Image build configuration
├── werf-giterminism.yaml       # Werf giterminism settings
└── FLAROPS.md                  # First-deployment instructions
```

`deploy/.env` is gitignored on purpose. Its contents belong in your repository's GitHub secrets — `FLAROPS.md` lists them.

## The dashboard

Deployed alongside your application at `dashboard.<your-domain>`, showing every node, every capsule, memory allocation and running AWS spend.

It requires a password to open. Flarops generates one during `init` and prints it once; only its hash reaches the cluster. The dashboard refuses to start without a credential rather than coming up open.

Memory figures account for what the kubelet reserves for itself and for the eviction threshold, so "free" means memory a capsule can actually take — not memory that exists on the machine.

## PR capsules

Opening a pull request deploys it to its own namespace at `<project>-pr-<number>.<domain>`, with the production database cloned into it. Closing the PR removes the namespace and reclaims any worker node that is left idle.

Before deploying, the pipeline asks the dashboard whether a capsule fits and which node has room. If none does, it adds a worker node; if the fleet has room, it uses it. Capsule pipelines run one at a time so two pull requests cannot be sent to the same node before either has landed.

## License

MIT
