# Flarops

Flarops reads your repository and writes the whole deployment for it: a Kubernetes chart, AWS infrastructure, image builds, and GitHub Actions pipelines. You get plain files you can read, edit and commit — nothing runs on someone else's server, and nothing is hidden behind a dashboard you cannot inspect.

## Install

```bash
npm install -g flarops
```

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

Then commit what it changed (`flarops.yaml`, `deploy/`, `werf.yaml`, `.github/workflows/`) and push. The pipeline deploys from what is in Git, so an uncommitted change does not reach the cluster.

**Sync is a merge, not a regeneration.** `init` learned things by reading your code that you cannot reasonably be asked to write down again — the database URLs it builds for each container, a migration step it found, SQL that seeds the database on first start. Those live in `deploy/.flarops-state.json` (committed, and not meant to be edited). Your edits are laid over them, so changing one line does not erase the rest.

Sync refuses rather than guessing. Unreadable YAML is reported with its line number and nothing is written. An empty `flarops.yaml` is treated as a truncated file, not as an instruction to delete your deployment.

## `flarops.yaml` — the file you edit

Every top-level key is a service. Here is a complete, ordinary example:

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

Some values appear more than once with a note to give them the same value. That happens when your `docker-compose.yml` read one credential into several variables — they have to match, or the services will not authenticate to each other.

## First deployment

After `init`, follow **`FLAROPS.md`** — it is generated for your project specifically and lists the exact steps in order. In short: create the GitHub secrets, commit everything, push to `main`, and watch the Actions run.

## What `init` asks you

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
| `Bucket [name] is already exist, are you sure you want to use it? [y/N]` | **Defaults to no.** An S3 bucket with the derived name already exists in your account. Answering yes stores this project's Terraform state in it. This is the one prompt where Enter declines, because agreeing by reflex could put your state in a bucket that belongs to something else. |

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

Deployed alongside your application at `dashboard.<your-domain>`, showing every node, every PR environment, memory allocation and running AWS spend.

It needs the password `init` printed. Only the hash reaches the cluster, and the dashboard refuses to start without a credential rather than coming up open.

Memory figures account for what Kubernetes reserves for itself, so "free" means memory something can actually use — not memory the machine has.

## Pull request environments

Opening a pull request deploys it to its own address at `<project>-pr-<number>.<domain>`, with the production database cloned into it. Closing the PR removes it and reclaims any machine left idle.

Before deploying, the pipeline asks the dashboard whether the environment fits and which machine has room. If none does, it adds one. Pull request pipelines run one at a time, so two of them cannot be sent to the same machine before either has landed.

## Features

- **Project analyzer.** Detects your frontend (React, Vue, Vite, Next, …), backends (Node, Python, Go, Java, PHP, Ruby, .NET), databases (PostgreSQL, MySQL, MariaDB, MongoDB), and the routes each service exposes.
- **Multi-service support.** Every service your compose file builds becomes its own Deployment, including several sharing one build context. Components you depend on but do not build (Redis, RabbitMQ, Keycloak, …) come with their configuration files carried into the cluster.
- **API gateway awareness.** If one service is the edge, the services behind it are kept off the public address so the gateway cannot be bypassed.
- **Helm chart.** Deployments, StatefulSets with storage, Services, Ingress, secrets wired from CI, health probes from your actual health routes.
- **Terraform.** A k3s cluster on EC2 with remote state in S3 (versioned, encrypted, private), and worker nodes that can be added and reclaimed individually.

## License

MIT
