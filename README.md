# Claude Managed Agents on Islo

Run [Claude Managed Agents (CMA)](https://platform.claude.com/docs/en/managed-agents) on Islo.

This repo provides a self-hosted control plane that allows you to:

- Run CMA sessions on **Islo Cloud Hypervisor (CLH) microVM sandboxes** — hardware-isolated VMs managed by [bear-agent](https://github.com/islo-labs/bear-agent)
- Customize sandbox size and runner image (`islo-runner-cma`)
- Apply **zero-trust egress controls** via Islo [gateway profiles](docs/egress.md) — allow/deny lists and credential injection without secrets inside the VM
- Persist workspace state across session idle/resume using Islo **named snapshots**
- Extend agents with custom tools in `src/dispatcher/` (stock tools included: `bash`, `read`, `write`, `edit`, `glob`, `grep`)

Follow the **[Quickstart](#quickstart)** to get running. Two deployment styles are supported: **Docker Compose** (recommended) and **local Node.js** from your laptop.

> [!IMPORTANT]
> **You need an Islo account with API access and an Anthropic Self-managed CMA environment.**
> This control plane calls the existing Islo sandbox API — it does not replace `islo-web-api` or require changes to it.

> [!IMPORTANT]
> **Consider this repository alpha software.** It is not yet stable and may contain bugs.

---

## Overview

This repository deploys a control plane service for running Claude Managed Agents on Islo.

When a CMA session starts or ends, Anthropic sends a signed webhook to your deployment. The control plane polls Anthropic's work queue, provisions an Islo sandbox for each session, runs a sidecar **tool dispatcher** that answers CMA stock tool calls via the sandbox exec/files API, and holds the work-item lease with a **heartbeat loop**.

When a session goes idle or terminates, the control plane snapshots `/workspace` through Islo's existing snapshot API so the same session ID can resume later.

```
Anthropic CMA
      │  webhooks + work queue
      ▼
claude-managed-agents  (this repo)
      │  Islo API key
      ▼
islo-web-api  (unchanged)
      │
      ▼
bear-agent  →  CLH microVM  +  teddyd  +  islo-runner-cma
      │
      ▼
Envoy MITM  →  islo-gateway  (egress policy + credential injection)
```

**Sandboxes** are CLH microVMs — full Linux guests with a separate kernel, not containers on the host. Each CMA session maps to one sandbox (created on first work item, restored from snapshot on resume).

**Egress** is handled by Islo's existing gateway stack. You configure a gateway profile once (allow `api.anthropic.com`, GitHub, npm, etc.; inject Anthropic credentials via integrations). Every sandbox created for CMA attaches that profile at create time. See [docs/egress.md](docs/egress.md).

**State persistence** uses Islo named snapshots (S3-backed). On `session.status_idled` or `session.status_terminated`, the control plane calls `POST /snapshots`. The next run for the same session ID creates a sandbox with `snapshot_name` set.

**Tool dispatch** runs in the control plane process, not inside the VM. The dispatcher reads Anthropic's session event stream and executes stock tools by calling `POST /sandboxes/{name}/exec` and the files API — the same protocol CMA expects, with Islo as the sandbox backend.

This repo is meant as a starting point: deploy it, connect your Anthropic self-managed environment, then customize runner image, gateway profile, sandbox sizing, or add custom tools.

---

## Architecture

### Request lifecycle

1. **Webhook arrives** — Anthropic posts to `POST /webhooks`. The handler verifies the [Standard Webhooks](https://docs.standardwebhooks.com/) signature (HMAC-SHA256, ±300s tolerance) and records the event.
2. **Drain work** — On `session.status_run_started`, the control plane polls `environments.work.poll` for pending session work items.
3. **Provision sandbox** — For each session, create or reuse an Islo sandbox via `POST /sandboxes` with `gateway_profile`, `islo-runner-cma` image, and Anthropic session env vars. Resume uses `snapshot_name` from a prior idle/terminate.
4. **Dispatch** — Start the tool dispatcher (event stream → stock tool handlers) and heartbeat loop in parallel. Do **not** ack work before the first heartbeat — the control plane owns the lease.
5. **Run** — Dispatcher answers `agent.tool_use` events with `user.tool_result` by exec'ing commands and reading/writing files in the sandbox.
6. **Persist** — On idle/terminate webhooks, snapshot the sandbox workspace via `POST /snapshots`.
7. **Stop** — When Anthropic signals stopping, abort the dispatcher and `work.stop({ force: true })`.

### Components

| Component | Role |
|---|---|
| `src/webhooks/` | Webhook ingress + signature verification |
| `src/sessions/coordinator.ts` | Work poll, sandbox provisioning, runner lifecycle |
| `src/dispatcher/` | Stock tool handlers + Anthropic event stream |
| `src/islo/client.ts` | Islo sandbox API client (create, exec, files, snapshots) |
| `src/storage/db.ts` | SQLite session registry (`session_id` → sandbox, snapshot) |
| `islo-runner-cma` | VM rootfs image ([bear-agent/images/islo-runner-cma](https://github.com/islo-labs/bear-agent/tree/main/images/islo-runner-cma)) |

### What runs where

| Layer | Runs where |
|---|---|
| Control plane | Your deployment (Docker / Node) |
| Tool dispatcher + heartbeat | Control plane sidecar |
| Agent workspace | CLH microVM (`/workspace`) |
| Egress policy + cred injection | bear-agent host (Envoy) + islo-gateway |
| Session metadata | SQLite in control plane |
| Workspace snapshots | Islo S3 (via web-api) |

---

## Quickstart

Work through the steps in order.

### Step 1. Configure Islo (one-time)

1. **Connect Anthropic integration** — `islo login --tool anthropic` or via the Islo dashboard → Integrations.
2. **Create a gateway profile** — Allow hosts your agents need (`api.anthropic.com` at minimum). See [docs/egress.md](docs/egress.md).
3. **Create an API key** — Islo dashboard → API Keys. Save it for Step 3.

### Step 2. Create an Anthropic environment and webhook

1. Create a **Self-managed** environment in the [Claude Platform Console](https://platform.claude.com/workspaces/default/environments).
2. In [Webhooks settings](https://platform.claude.com/settings/workspaces/default/webhooks), set the URL to:

   ```
   https://<your-control-plane-host>/webhooks
   ```

3. Save these values — you will need them in Step 3:

   | Value | Description |
   |---|---|
   | `ENVIRONMENT_ID` | Your self-managed environment ID |
   | `ANTHROPIC_ENVIRONMENT_KEY` | Environment key (`sk-ant-oat01-...`) — used for work poll, heartbeat, and event stream |
   | `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) |
   | `WEBHOOK_SECRET` | Standard Webhooks signing secret from the webhook settings page |

### Step 3. Deploy the control plane

#### Docker Compose (recommended)

```bash
git clone https://github.com/islo-labs/claude-managed-agents.git
cd claude-managed-agents
cp .env.example .env
# Edit .env — see Configuration reference below
docker compose up --build -d
```

Your control plane listens on port **8787** by default. Put a reverse proxy or load balancer with TLS in front for production.

#### Local development

```bash
git clone https://github.com/islo-labs/claude-managed-agents.git
cd claude-managed-agents
cp .env.example .env
# Edit .env
npm install
npm run dev
```

### Step 4. Set environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `ENVIRONMENT_ID` | yes | Anthropic self-managed environment ID |
| `ANTHROPIC_ENVIRONMENT_KEY` | yes | Environment key for poll / heartbeat / event stream |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `WEBHOOK_SECRET` | yes | Standard Webhooks HMAC secret |
| `ISLO_API_KEY` | yes | Islo API key |
| `ISLO_API_BASE_URL` | yes | e.g. `https://api.islo.dev` |
| `ISLO_GATEWAY_PROFILE` | recommended | Gateway profile name attached to every CMA sandbox |
| `ISLO_RUNNER_IMAGE` | no | Default: `ghcr.io/islo-labs/islo-runner-cma:latest` |
| `ISLO_SANDBOX_CPUS` | no | Default: `2` |
| `ISLO_SANDBOX_MEMORY_MB` | no | Default: `4096` |
| `ISLO_SANDBOX_DISK_GB` | no | Default: `20` |
| `PORT` | no | Default: `8787` |
| `DATABASE_PATH` | no | Default: `./data/sessions.db` |

Optional:

| Variable | Description |
|---|---|
| `ANTHROPIC_BASE_URL` | Override Anthropic API base URL (default: `https://api.anthropic.com`) |

### Step 5. Verify

```bash
curl http://localhost:8787/health
curl http://localhost:8787/sessions
```

Trigger a CMA session from the Anthropic console or your agent configuration. You should see:

- A webhook logged by the control plane
- A new Islo sandbox created (visible in Islo dashboard or `GET /sessions`)
- Tool calls completing without hanging on `requires_action`

### Step 6. Secure the control plane (production)

**The webhook endpoint and session API are not authenticated by default.**

Before exposing this service on the public internet:

- Terminate TLS at a reverse proxy (nginx, Caddy, etc.)
- Restrict network access to Anthropic webhook IP ranges where possible
- Do not expose `/sessions` publicly without auth
- Run the control plane on private infrastructure reachable only from Anthropic + your ops team

---

## Configuration reference

See [`.env.example`](.env.example) for all options.

### Runner image

CMA sandboxes use [`islo-runner-cma`](https://github.com/islo-labs/bear-agent/tree/main/images/islo-runner-cma) — the standard `islo-runner` image plus the Anthropic `ant` CLI and `ripgrep`. Published to `ghcr.io/islo-labs/islo-runner-cma:latest` after the [bear-agent CI](https://github.com/islo-labs/bear-agent) merges.

### API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service info |
| `GET` | `/health` | Health check |
| `POST` | `/webhooks` | Anthropic webhook ingress |
| `GET` | `/sessions` | Local session → sandbox registry |

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build && npm start
```

---

## License

[MIT](./LICENSE)
