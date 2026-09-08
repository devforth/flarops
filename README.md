# Flarops

Flarops is an intelligent DevOps CLI tool designed to automate the deployment of multi-tier web applications. It analyzes your source code to automatically generate Kubernetes Helm charts, Terraform infrastructure configurations, Werf build manifests, and GitHub Actions CI/CD pipelines.

## 🚀 Features

- **Smart Project Analyzer:** Automatically detects your frontend (React, Vue, Vite, etc.), backend (Go, Node.js, Python), and database type (MySQL, PostgreSQL, MongoDB).
- **Helm Chart Generator:** Creates Deployments, StatefulSets (with PVCs for databases), Services, and Traefik Ingress routing tailored to your project.
- **Werf & Giterminism Integration:** Dynamically generates `werf.yaml` and `werf-giterminism.yaml` for seamless image building and deployment.
- **Terraform State Management:** Automatically sanitizes project names and provisions an AWS S3 bucket to safely store your Terraform remote state.
- **CI/CD Ready:** Instantly generates a `.github/workflows/deploy.yml` pipeline.

## 📦 Installation

To use Flarops locally during development, navigate to the Flarops directory and link it:

```bash
npm link
```

## 🛠️ Usage

Navigate to the root of your application repository (it must be a Git repository) and run:

```bash
flarops init
```

The CLI will interactively ask for:
- AWS Credentials (or automatically pick up your default `~/.aws/credentials`).
- Docker Registry credentials (e.g., Docker Hub).
- Project Domain (optional, used for Ingress).

### Directory Structure Generated

After initialization, Flarops will generate the following structure in your repository:

```text
.
├── deploy/
│   ├── helm/              # Complete Kubernetes Helm chart
│   ├── terraform/         # Terraform AWS infrastructure
│   ├── .env               # Production environment variables
│   └── .env.safety        # Internal deploy configuration
├── .github/
│   └── workflows/
│       └── deploy.yml     # GitHub Actions pipeline
├── werf.yaml              # Werf build configuration
└── werf-giterminism.yaml  # Werf Giterminism settings
```

## 📄 License

This project is licensed under the MIT License.
