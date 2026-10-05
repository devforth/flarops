# Flarops

Flarops reads your repository and writes the whole deployment for it: a Kubernetes chart, AWS infrastructure, image builds, and GitHub Actions pipelines. You get plain files you can read, edit and commit — nothing runs on someone else's server, and nothing is hidden behind a dashboard you cannot inspect.

## Install

```bash
npm install -g flarops
```

or run it without installing: `npx flarops init`.

## Before you start

**Your project**

- A Git repository. Flarops runs from its root.
- A `Dockerfile` for every service you want deployed. A service without one is not built.
- A `docker-compose.yml` is not required, but it is the best input: services, ports, environment, commands, volumes and dependencies are read from it.

**On your machine**

- Node.js 18 or newer, `git`, Docker (for `docker login`) and `ssh-keygen`.
- The AWS CLI. If it is missing, Flarops installs a signature-verified copy into `~/.local` — on Linux x86_64 only, and that needs `curl`, `unzip` and `gpg`. On other platforms install it yourself first.

**Accounts**

- **AWS** — an access key that can create a VPC, EC2 instances, an Elastic IP, security groups and an S3 bucket.
- **A container registry** — Docker Hub or any other. Images are pushed there and pulled by the cluster.
- **GitHub** — the repository, with Actions enabled. Deploys run there.
- **A domain** — required: the dashboard and every pull-request environment get addresses derived from it.
- **Cloudflare** (optional, recommended) — manages the DNS records and provides HTTPS (see below).

## The two commands

Flarops has two commands, and the difference between them is the thing worth understanding first.

```
flarops init   →  once, at the start.  Reads your code, asks what it cannot know,
                  writes everything, and creates flarops.yaml.

flarops sync   →  every time after.    Reads flarops.yaml and makes the deployment
                  match it.
```

### `flarops init` — run once

From the root of your Git repository:

```bash
flarops init
```

It looks through your project: which services you have, what they build from, which ports they listen on, which database you use, what routes your backend serves. Where `docker-compose.yml` exists it is trusted as the inventory; where it does not, the directory layout is read instead. Then it asks for the handful of things no code can tell it — your registry, your domain, your AWS credentials — and writes the deployment.

At the end it writes **`flarops.yaml`**: a plain description of everything it decided. From that point on, that file is the deployment.

`init` will not run a second time. If you run it again in a project that already has `flarops.yaml`, it stops and says so. That is deliberate: a second run would ask for your registry password again, issue a new deploy key and a new dashboard password, and overwrite the chart from a fresh analysis — throwing away every change you made since. To change the deployment, edit `flarops.yaml` and run `sync`.

### `flarops sync` — run after every edit

```bash
flarops sync
```

It reads `flarops.yaml` and brings the rest into line:

| You do | Sync does |
| --- | --- |
| Change a value | Updates that object in the chart |
| Add a service block | Creates the service — same templates a discovered one gets, defaults for anything you left out — and teaches the image build about it |
| Remove a service block | Deletes its chart template and drops it from the configuration |
| Add a secret | Adds it to the chart **and** to the GitHub Actions workflow, so CI passes it |

Sync prints every change before writing anything:

```
Applying flarops.yaml:
  api.replicas: 1 -> 3
  api.secretEnvs (same name): none -> ["STRIPE_KEY"]
  GitHub Secret STRIPE_KEY: now required by the chart
```

Then commit what it changed (`flarops.yaml`, `deploy/`, `werf.yaml`, `werf-giterminism.yaml`, `.github/workflows/`) and push. The pipeline deploys from what is in Git, so an uncommitted change does not reach the cluster.

**Sync is a merge, not a regeneration.** `init` learned things by reading your code that you cannot reasonably be asked to write down again — the database URLs it builds for each container, a migration step it found, SQL that seeds the database on first start. Those live in `deploy/.flarops-state.json` (committed, and not meant to be edited). Your edits are laid over them, so changing one line does not erase the rest.

Sync refuses rather than guessing. Unreadable YAML is reported with its line number and nothing is written. An empty `flarops.yaml` is treated as a truncated file, not as an instruction to delete your deployment. Values that would end up somewhere they cannot be — a service name that is not a valid Kubernetes name, a secret name GitHub would not accept, a port outside 1–65535, a `context` outside the repository — are refused with the field named, before anything is written.

## `flarops.yaml` — the file you edit

It opens with where the images are pushed:

```yaml
# repository settings
repositorySettings:
  registry: docker.io        # registry host
  project: null              # namespace inside the registry
  repository: shop           # repository the images are pushed to
```

The images end up at `<registry>/<project>/<repository>` — `harbor.example.com/team/shop` for a Harbor project, `ghcr.io/acme/shop` for a GitHub organisation. Leave `project` as `null` when the registry has no such level; on Docker Hub, `null` means your own user (`docker.io/<user>/shop`). `init` fills this in from the registry you gave it (`harbor.example.com/team` is split into registry and project) and names the repository after the project directory. Changing any of it and running `sync` updates both workflows; log-in still goes to the registry host with the same credentials.

Every other top-level key is a service. Here is a complete, ordinary example:

```yaml
api:
  dockerfile: Dockerfile
  context: backend
  replicas: 2
  ports:
    - 5000
  env:
    NODE_ENV: production
    DB_HOST: database
  secretEnvs:
    JWT_SECRET: JWT_SECRET
  healthRoute: /health
  exposedRoutes:
    - /api

frontend:
  dockerfile: Dockerfile
  context: client
  replicas: 1
  ports:
    - 5173
  buildArgs:
    - "VITE_API_URL=https://example.com/api"

database:
  image: "postgres:16-alpine"
  replicas: 1
  port: 5432
  user: appuser
  name: appdb
  type: postgres
  secretEnvs:
    POSTGRES_PASSWORD: POSTGRES_PASSWORD
```

### Every service needs

A service is either **built here** or **pulled from a registry** — one or the other:

```yaml
  dockerfile: Dockerfile     # built here
  context: backend           #   paths are relative to the project root
```

```yaml
  image: "redis:7"           # pulled
```

and `replicas: 1` — how many copies run.

### The fields you will actually use

**`ports`** — the ports the container listens on.

```yaml
  ports:
    - 5000
```

**`env`** — plain configuration. These end up in the chart in clear text, so nothing secret belongs here.

```yaml
  env:
    NODE_ENV: production
    DB_HOST: database
```

Use the service's name as a hostname: `database`, `api`, `frontend`. Inside the cluster `localhost` means *this container*, not the machine — Flarops rewrites obvious cases and warns about the rest.

**`secretEnvs`** — configuration that must not be in the repository. This is the field people get wrong most often, because it has **two names on each line**:

```yaml
  secretEnvs:
    JWT_SECRET: JWT_SECRET             # same name on both sides - the usual case
    DB_PASSWORD: SHARED_DB_PASSWORD    # different: see below
```

The name on the **left** is the environment variable your code reads. The name on the **right** is the GitHub Secret it comes from. They are usually identical, and then you write it twice. They differ when two services read one credential under different names: both point at the same GitHub Secret, so there is one value to rotate instead of two that can drift apart.

**Put each secret under the service that reads it.** A secret listed under a service that never reads it will reach the cluster and reach no container — which looks exactly like the secret not working. Sync warns when it sees one:

> WARNING: CI passes these Secret keys but no workload reads them: JWT_SECRET.

**`databaseUrls`** — environment variables that get a connection URL to the database, built by the chart. Don't make the URL a secret yourself: the chart builds it from the database's user, name and password, so it changes when they do.

```yaml
  databaseUrls:
    - DATABASE_URL     # postgresql://<user>:<password>@database:5432/<name>
```

The URL points at the service's own `db:` if it has one, otherwise at the top-level `database:`. It works on `api` and on services built here. A name listed here cannot also be in `env` or `secretEnvs`. `init` writes the field wherever it builds a URL. In a project generated before the field existed, sync keeps the URLs `init` built until flarops.yaml names them; write `databaseUrls: []` to stop one.

**`exposedRoutes`** — the URL prefixes the outside world reaches this service through.

```yaml
  exposedRoutes:
    - /api
    - /uploads
```

If a reverse proxy used to strip the prefix before your service saw it — the usual setup where the browser calls `/api/users` and the backend serves `/users` — say so:

```yaml
  exposedRoutes:
    - path: /api
      stripPrefix: true
    - /webhooks
```

Without `stripPrefix`, your service receives `/api/users` and answers 404.

**`volumes`** — storage that survives a restart. Without one, anything a container writes is gone when the pod is replaced.

```yaml
  volumes:
    - name: uploads
      path: /app/uploads
      size: 20Gi          # optional, 5Gi by default
```

A volume makes the service restart by stopping the old pod before starting the new one, because two pods cannot hold the same disk.

**`healthRoute`** and **`healthPort`** — the path Kubernetes calls to decide whether your service is alive. Set them if the service has a health endpoint; leave them out otherwise.

**`buildArgs`** — values passed to `docker build`, for anything compiled *into* the image. Frontend frameworks do this: `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_` values are baked in at build time, so setting them as runtime `env` has no effect.

```yaml
  buildArgs:
    - "VITE_API_URL=https://example.com/api"
```

**`command`** — what the container runs, when it should not be the image's default.

```yaml
  command: ["node", "dist/worker.js"]
```

A development-server command from `docker-compose.yml` (`--reload`, `--watch`, `npm run dev`, `next dev`, `nodemon`, …) is not carried over when the image has a `CMD` of its own — the image's command runs instead, and `init` says so. Set `command` here if production needs something else.

### A task, not a service

Something that runs once and finishes — creating queue topics, seeding a store — is not a service. Declared as one it would exit, be restarted, exit again, forever.

```yaml
topic-setup:
  image: "my-registry/cli:1"
  oneShot: true
  command: ["create-topics"]
```

`oneShot` replaces `replicas`. It runs on every deploy, so the command must be safe to repeat (`--if-not-exists`, an upsert). A task has no address, so it takes no `ports` and no `exposedRoutes`.

### A service with its own database

Most projects have one `database:` block that everything shares. When one service needs a database of its own:

```yaml
reporting:
  dockerfile: Dockerfile
  context: reporting
  replicas: 1
  db:
    type: postgres          # postgres | mysql | mariadb | mongodb
    image: "postgres:16-alpine"
    port: 5432
    user: postgres
    name: reports
```

It gets its own StatefulSet and its own storage.

### Database server settings

A database takes server settings the same way a service takes its command — `command:` replaces the image's CMD and keeps its entrypoint, exactly as in docker-compose. It works on the top-level `database:` block and on a service's `db:` block:

```yaml
database:
  image: "postgres:18"
  type: postgres
  command:
    - postgres
    - -c
    - wal_level=logical
```

`init` carries a database's `command:` over from docker-compose. A command that uses `${VAR}` is not carried — compose fills those in from `.env`, a pod cannot — and `init` says so; write it with the values themselves.

## Secrets, end to end

This is the one part you do by hand, so it is worth seeing whole.

1. `init` writes **`deploy/.env`** — a checklist, not a config file. It is gitignored and nothing reads it at deploy time; it exists so you know what to create.
2. It also prints the list when it finishes, marking anything that needs attention:

   ```
   Create these 8 GitHub repository secrets before the first deploy
   (Settings -> Secrets and variables -> Actions). Values are in deploy/.env:
     AWS_ACCESS_KEY_ID  (infrastructure)
     JWT_SECRET
     RPK_PASS  <- give it the SAME value as REDPANDA_PASSWORD
     STRIPE_KEY  <- no service reads this; declare it under a service's secretEnvs
   ```
3. You create each one in **your repository's** GitHub Secrets, under the same name.
4. On deploy, the workflow passes them to the chart, which puts them in a Kubernetes Secret, which your containers read.

A secret is missing from step 3 → the pod cannot start. A secret exists but no service declares it in `secretEnvs` → it sits in the cluster unused. Both are reported; neither is guessed at.

Values from `.env.example`, `.env.sample` and `.env.template` are never used: those files are committed, so their values are public. Their keys still count — the secret is wired and listed — but its value is left empty, marked `<- no value found; you must supply one`. The same goes for an obvious placeholder in a real `.env` (`changeme`, `your-…-here`, `replace_me`). A database password taken from one of those, or set to the engine's default (`postgres`, `root`, `admin`), is replaced with a random one. `init` lists every value it set aside.

**Variables Flarops cannot see are yours to add.** It reads `.env` files, `environment:` and `env_file:` in `docker-compose.yml`, and the variables your source reads directly. Anything else — fields of a settings class (pydantic `BaseSettings`, …), variables a library reads by itself (`AUTH_SECRET` for next-auth, …), values only your README mentions — add to `flarops.yaml` (`env` or `secretEnvs`) and run `sync`. A required variable that is missing usually shows up as a container that exits at start.

Some values appear more than once with a note to give them the same value. That happens when your `docker-compose.yml` read one credential into several variables — they have to match, or the services will not authenticate to each other.

## First deployment

After `init`, follow **`FLAROPS.md`** — it is generated for your project specifically and lists the exact steps in order. In short: create the GitHub secrets, commit everything, push to `main`, and watch the Actions run.

## What `init` asks you

### Values it collects

None of these change anything on their own — they are written into the generated configuration.

| Prompt | Notes |
| --- | --- |
| `Enter docker registry` | Leave empty for Docker Hub. A project inside the registry can be included: `harbor.example.com/team`. Both can be changed later under `repositorySettings`. |
| `Enter username for <registry>` | |
| `Enter password for <registry>` | Hidden. Used immediately for `docker login`, then stored in `deploy/.env`. |
| `Enter project domain` | Required, asked again until it is a valid domain name. The dashboard and the pull-request environments are addressed under it. |
| `Enter Cloudflare API Token` | Only if you enabled Cloudflare DNS. Hidden. |
| `Enter Cloudflare Zone ID` | Only if you enabled Cloudflare DNS. |
| `Enter project AWS Access Key ID` | Press Enter to use your default `~/.aws/credentials`. |
| `Enter project AWS Secret Access Key` | Hidden. Only asked if you entered an Access Key ID. |
| `Enter AWS region` | Press Enter for `us-west-2`. |
| `Enter new bucket name` | Only if the Terraform state bucket name is taken or invalid. |

### Questions that change what gets built

| Prompt | What it changes |
| --- | --- |
| `Do you want to configure Cloudflare DNS for this domain automatically? [Y/n]` | **Defaults to yes.** Adds DNS records for your domain and its wildcard, so deploys point the domain at the cluster for you. Answer `n` to manage DNS yourself. |
| `This project has no docker-compose.yml, but it does have "<file>". Base the deployment on it? [Y/n]` | **Defaults to yes.** Asked when your compose file is not conventionally named — those are often a local development stack, and generating production from one would carry its images and mounts into the cluster. Answer `n` and services are found from the directory layout alone. |

### Questions that modify your source code

**These default to yes.** Pressing Enter accepts them, and they rewrite files in your repository — not in `deploy/`. Commit or stash your work before running `init` if you want to review or undo the changes.

| Prompt | What it changes |
| --- | --- |
| `Do you want to automatically refactor hardcoded frontend API URLs to environment variables? [Y/n]` | Replaces hardcoded API URLs in your frontend source with environment variable reads. |
| `Do you want to automatically refactor hardcoded database URLs in the backend to environment variables? [Y/n]` | Replaces hardcoded database connection strings in your backend source. |
| `Found lowercase environment variables in backend code (…). Do you want to automatically refactor them? [Y/n]` | Renames the listed variables to UPPERCASE in your backend source and in your `.env` files. |

Answer `n` to any of them to leave your source untouched. Flarops still generates a complete deployment — you then wire those values yourself.

### The one question where Enter means no

| Prompt | Notes |
| --- | --- |
| `Bucket [name] is already exist, are you sure you want to use it? (...) [y/N]` | **Defaults to no.** An S3 bucket with the derived name already exists and your credentials can reach it. Answering yes stores this project's Terraform state in it — including the k3s cluster token — so check it is listed in **your** account first. This is the one prompt where Enter declines, because agreeing by reflex could put your state in a bucket that belongs to something else. A name taken by another account that you cannot reach is not asked about: `init` says so and asks for a different name. |

### What `init` does without asking

- **Writes `deploy/`, `werf.yaml`, `werf-giterminism.yaml`, `FLAROPS.md` and `flarops.yaml`.**
- **Generates an SSH deploy key in `.keys/`** if there is none, and appends `.env`, `.keys/` and Terraform artefacts to your `.gitignore`. A key already tracked by Git stops the run with instructions rather than being reused.
- **Runs `docker login`** against your registry to verify the credentials.
- **Creates the Terraform state S3 bucket** if it does not exist, with versioning, encryption and public access blocking enabled.
- **Generates a dashboard password**, shows it once, and stores only its hash. It cannot be recovered — save it when it appears.
- **Creates `.dockerignore`** if any service builds from the repository root, to keep `deploy/`, `.env` and `.keys/` out of your images.

Flarops prints warnings for anything it could not resolve — unset variables, ambiguous routes, files it could not carry into the cluster, compose services it had to skip. Read them: they are the parts of the deployment that need your attention before it will work.

## What gets generated

```text
.
├── flarops.yaml                # ← the file you edit
├── deploy/
│   ├── helm/                   # Kubernetes chart
│   │   ├── templates/          # one file per service, plus ingress and secrets
│   │   └── values.yaml         # written by sync; edit flarops.yaml instead
│   ├── terraform/              # AWS infrastructure (k3s on EC2, S3 remote state)
│   ├── dashboard/              # fleet dashboard, deployed with your app
│   ├── .flarops-state.json     # what init worked out; committed, not hand-edited
│   └── .env                    # checklist of secrets to create (gitignored)
├── .github/workflows/
│   ├── deploy.yml              # deploys on push to main
│   └── pr-capsule.yml          # per-PR environment, created and removed automatically
├── .keys/                      # deploy SSH key (gitignored)
├── werf.yaml                   # image build configuration
└── FLAROPS.md                  # first-deployment instructions
```

Everything under `deploy/helm/` is written by Flarops. Edit `flarops.yaml` and run `sync`; hand edits there are overwritten.

## The dashboard

Deployed alongside your application, showing every node, every PR environment, memory allocation and running AWS spend. Its address is `dashboard.` plus your domain without its first label: `dashboard.example.com` for both `example.com` and `app.example.com`.

It needs the password `init` printed. Only the hash reaches the cluster, and the dashboard refuses to start without a credential rather than coming up open.

Memory figures account for what Kubernetes reserves for itself, so "free" means memory something can actually use — not memory the machine has.

## Pull request environments

Opening a pull request deploys it to its own address, with the production database cloned into it: `pr-<number>.example.com` for the domain `example.com`, or `app-pr-<number>.example.com` for `app.example.com`. Closing the PR removes it and reclaims any machine left idle.

Before deploying, the pipeline asks the dashboard which machine has room for the environment, sized by what the same application uses in production right now. If none has room, it adds a worker machine — after waiting for any that another pull request is already adding. A "yes" reserves the machine until the environment appears, so two pull requests cannot be sent to the same room. All of one environment's pods run on its machine, so closing the PR leaves that machine empty and it can be removed.

A pull request environment runs with the production secrets and a copy of the production data. That is intended for **private repositories**, where everyone who can open a pull request is trusted. Pull requests from forks receive no secrets, and their pipelines fail.

## What it deploys

| Layer | What you get |
| --- | --- |
| Infrastructure | AWS: one VPC with a public subnet, an EC2 instance (`t3a.medium`, Ubuntu 22.04 amd64, 40 GB gp3 root volume) behind an Elastic IP. Terraform state in S3 with native locking. |
| Cluster | k3s `v1.36.4+k3s1`, pinned: one server node, plus worker nodes added and removed for pull-request environments. Traefik (built into k3s) is the ingress; volumes use k3s's local-path storage. |
| Build and deploy | GitHub Actions run Terraform, then werf: it builds the images, pushes them to your registry and deploys the Helm chart. A push to `main` deploys production. |
| DNS and HTTPS | With Cloudflare, the deploy creates DNS records for your domain and its wildcard, proxied through Cloudflare, which serves HTTPS. The cluster itself serves plain HTTP on port 80. |
| Databases | PostgreSQL, MySQL, MariaDB or MongoDB as a StatefulSet. The image your `docker-compose.yml` pins is used; otherwise `postgres:18-alpine`, `mysql:26`, `mariadb:13` or `mongo:8`. |
| Dashboard | A small Go service with SQLite on a 1 Gi volume. It reads EC2 prices from `instances.vantage.sh`, so it needs outbound internet access. |

**All of this is yours to change.** The generated files are ordinary Terraform and Helm, and you can edit them to fit what you need:

- `deploy/terraform/variables.tf` — instance type, root volume size, region, k3s version, domain.
- `deploy/terraform/main.tf` — the rest of the infrastructure: the AMI, the security group rules, disk encryption, the network.
- `deploy/helm/` — the chart: `values.yaml` and one template per service (probes, resource limits, storage sizes, Ingress annotations).

Terraform files are never touched again after `init`, so edit them freely. The chart is different: `flarops sync` rewrites `deploy/helm/`, so a hand edit there lasts only until the next sync. Anything `flarops.yaml` can express — replicas, ports, env, secrets, routes, volumes, commands — belongs in `flarops.yaml`; edit the chart directly only for what it cannot, and re-apply the edit after each sync.

## Good to know before you rely on it

- **One server, one disk.** The control plane, production and its database run on a single EC2 instance, and volumes live on its root disk. Nothing is replicated and nothing is backed up automatically — set up database backups yourself.
- **Open ports.** The security group allows 22 (SSH), 80 (HTTP) and 6443 (Kubernetes API) from anywhere. Narrow them in `deploy/terraform/main.tf` if you need to.
- **HTTPS comes from Cloudflare.** Port 443 is not open. Without Cloudflare's proxy the application is plain HTTP, and the dashboard cannot be logged into: its session cookies are only sent over HTTPS.
- **The root volume is not encrypted** unless you turn it on in `deploy/terraform/main.tf`.
- **Terraform is written once.** `init` generates `deploy/terraform/`; `sync` does not touch it, and keeping it up to date is up to you. Changes to the AMI or to the instance's startup script reach new instances only — replace one deliberately (`terraform apply -replace=aws_instance.server`), remembering that its disk holds the cluster's data.
- **It costs money.** EC2 instances, their volumes, the Elastic IP and the S3 bucket are billed to your AWS account. A worker added for a pull request is billed until the PR is closed and the worker is reclaimed.
- **amd64 only.** The instances and the k3s install are x86_64.

## Features

- **Project analyzer.** Detects your frontend (React, Vue, Vite, Next, …), backends (Node, Python, Go, Java, PHP, Ruby, .NET), databases (PostgreSQL, MySQL, MariaDB, MongoDB), and the routes each service exposes.
- **Multi-service support.** Every service your compose file builds becomes its own Deployment, including several sharing one build context. Components you depend on but do not build (Redis, RabbitMQ, Keycloak, …) come with their configuration files carried into the cluster.
- **API gateway awareness.** If one service is the edge, the services behind it are kept off the public address so the gateway cannot be bypassed.
- **Helm chart.** Deployments, StatefulSets with storage, Services, Ingress, secrets wired from CI, health probes from your actual health routes.
- **Terraform.** A k3s cluster on EC2 with remote state in S3 (versioned, encrypted, private), and worker nodes that can be added and reclaimed individually.

## License

MIT
