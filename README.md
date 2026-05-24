# Claude Managed Agents on Islo

Run [Claude Managed Agents (CMA)](https://platform.claude.com/docs/en/managed-agents) on Islo.

This repo is a **self-hosted control plane** you deploy on your infrastructure. It connects your Anthropic CMA environment to **Islo sandboxes** — isolated environments where agent code runs safely, with controlled network access and no secrets inside the sandbox.

With this control plane you can:

- Run CMA agent sessions on **hardware-isolated Islo sandboxes**
- **Control outbound access** — allow only the domains your agents need
- **Inject credentials at the network layer** — API keys never land in the sandbox filesystem or process env
- **Persist workspace state** across session idle and resume
- Customize sandbox size (CPU, memory, disk) and base image

Follow the **[Quickstart](#quickstart)** to get running. Deploy with **Docker Compose** (recommended) or **Node.js** locally.

> [!IMPORTANT]
> **You need an [Islo](https://islo.dev) account and an Anthropic Self-managed CMA environment.**

> [!IMPORTANT]
> **This project is alpha software.** APIs and behavior may change.

---

## Overview

Anthropic's Claude Managed Agents platform sends webhooks when agent sessions start, idle, or end. This control plane receives those events, claims work from Anthropic's queue, and runs each session inside an Islo sandbox.

For every session:

1. A **sandbox is provisioned** (or restored from a previous snapshot)
2. A **tool dispatcher** answers CMA tool calls (`bash`, `read`, `write`, and the rest of the stock toolset)
3. A **heartbeat** keeps the session lease alive until Anthropic signals stop
4. On idle or terminate, the **workspace is snapshotted** so the next run can pick up where it left off

```
Anthropic CMA
      │  webhooks + work queue
      ▼
claude-managed-agents  ← you deploy this
      │  Islo API
      ▼
Islo sandboxes  ← isolated agent environments
      │
      ▼
Controlled egress  ← allowlists + credential injection
```

**Sandboxes** are isolated Linux environments on Islo — separate from your laptop, CI runners, or production servers. Each CMA session gets its own sandbox. Files live under `/workspace`.

**Network access** is governed by an Islo **gateway profile** you configure once. You choose which hosts agents may reach (e.g. `api.anthropic.com`, GitHub, npm). Credentials for those services are injected in transit — the agent never sees the raw API key. See [Network access and credentials](docs/egress.md).

**Persistence** — when a session idles or ends, the control plane saves a snapshot of the workspace. When the same session runs again, that snapshot is restored automatically.

This repo is a starting point. Deploy it, point Anthropic at your webhook URL, and customize sandbox sizing, network policy, or tools as needed.

---

## Architecture

### Session lifecycle

1. **Webhook** — Anthropic notifies your control plane that a session needs work (or has idled / ended). Signatures are verified using the [Standard Webhooks](https://docs.standardwebhooks.com/) scheme.
2. **Claim work** — The control plane polls Anthropic's environment work queue and picks up the session.
3. **Start sandbox** — An Islo sandbox is created for the session, or restored from a saved snapshot if one exists.
4. **Run agent tools** — The control plane reads Anthropic's session event stream and executes tool calls inside the sandbox (`bash`, file read/write, etc.).
5. **Heartbeat** — While the session is active, the control plane maintains the work-item lease with Anthropic.
6. **Snapshot** — On idle or terminate, the workspace is saved for next time.
7. **Stop** — When Anthropic ends the session, the dispatcher shuts down cleanly.

### What you deploy vs what Islo provides

| You deploy | Islo provides |
|---|---|
| This control plane (Docker or Node) | Sandboxes — isolated agent runtimes |
| Anthropic + Islo credentials in `.env` | Gateway — egress allowlists and credential injection |
| A public HTTPS URL for `/webhooks` | Snapshots — workspace persistence |
| (Optional) TLS reverse proxy | Dashboard — view sandboxes, logs, and usage |

---

## Quickstart

Work through the steps in order.

### Step 1. Set up Islo

1. Sign up at [islo.dev](https://islo.dev) and create an API key.
2. **Connect Anthropic** — run `islo login --tool anthropic` or connect via the Islo dashboard → Integrations.
3. **Create a gateway profile** — allow the hosts your agents need. At minimum: `api.anthropic.com`. See [Network access and credentials](docs/egress.md).
4. Note your **API key** and **gateway profile name** for Step 3.

### Step 2. Create an Anthropic environment and webhook

1. In the [Claude Platform Console](https://platform.claude.com/workspaces/default/environments), create a **Self-managed** environment.
2. In [Webhooks settings](https://platform.claude.com/settings/workspaces/default/webhooks), set the webhook URL to:

   ```
   https://<your-control-plane-host>/webhooks
   ```

3. Save these values for Step 3:

   | Value | Where to find it |
   |---|---|
   | `ENVIRONMENT_ID` | Environment details in the Claude console |
   | `ANTHROPIC_ENVIRONMENT_KEY` | Environment secret key (`sk-ant-oat01-...`) |
   | `ANTHROPIC_API_KEY` | Anthropic API key (`sk-ant-...`) |
   | `WEBHOOK_SECRET` | Webhook signing secret from the webhooks page |

### Step 3. Deploy the control plane

#### Docker Compose (recommended)

```bash
git clone https://github.com/islo-labs/claude-managed-agents.git
cd claude-managed-agents
cp .env.example .env
# Edit .env — fill in Anthropic + Islo values from Steps 1–2
docker compose up --build -d
```

The service listens on port **8787** by default. Put HTTPS in front of it before going to production (see Step 6).

#### Local development

```bash
git clone https://github.com/islo-labs/claude-managed-agents.git
cd claude-managed-agents
cp .env.example .env
npm install
npm run dev
```

### Step 4. Configure environment variables

| Variable | Required | Description |
|---|---|---|
| `ENVIRONMENT_ID` | yes | Anthropic self-managed environment ID |
| `ANTHROPIC_ENVIRONMENT_KEY` | yes | Environment key |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `WEBHOOK_SECRET` | yes | Webhook signing secret |
| `ISLO_API_KEY` | yes | Islo API key |
| `ISLO_API_BASE_URL` | yes | Islo API URL (e.g. `https://api.islo.dev`) |
| `ISLO_GATEWAY_PROFILE` | recommended | Gateway profile name from Step 1 |
| `ISLO_RUNNER_IMAGE` | no | Sandbox base image (default: `ghcr.io/islo-labs/islo-runner:latest`) |
| `ISLO_SANDBOX_CPUS` | no | vCPUs per sandbox (default: `2`) |
| `ISLO_SANDBOX_MEMORY_MB` | no | Memory per sandbox (default: `4096`) |
| `ISLO_SANDBOX_DISK_GB` | no | Disk per sandbox (default: `20`) |

See [`.env.example`](.env.example) for all options.

### Step 5. Verify

```bash
curl https://<your-control-plane-host>/health
```

Start a CMA session from the Anthropic console. You should see:

- Webhook events received by the control plane
- A new sandbox in the [Islo dashboard](https://app.islo.dev)
- Agent tool calls completing (no indefinite hang on `requires_action`)

### Step 6. Secure for production

The control plane is **not authenticated by default**. Before exposing it publicly:

- Terminate **TLS** at a reverse proxy (nginx, Caddy, a load balancer, etc.)
- Restrict who can reach the service besides Anthropic's webhook delivery
- Do not expose internal endpoints (like `/sessions`) without access controls

---

## Configuration reference

### Control plane endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/webhooks` | Anthropic webhook receiver |
| `GET` | `/sessions` | Session status (restrict in production) |

### Further reading

- [Network access and credentials](docs/egress.md) — gateway profiles and Anthropic integration setup

---

## Development

For contributors working on this repo:

```bash
npm install
npm run typecheck
npm test
npm run build && npm start
```

---

## License

[MIT](./LICENSE)
