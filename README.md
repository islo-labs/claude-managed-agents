# Claude Managed Agents on Islo

Self-hosted [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) control plane that runs agent sessions on **Islo Cloud Hypervisor (CLH) sandboxes** instead of Cloudflare Containers.

This repo is **not a fork** of [cloudflare/claude-managed-agents](https://github.com/cloudflare/claude-managed-agents). It implements the same CMA webhook/work protocol and uses Islo's existing sandbox API as the compute backend.

## Architecture

```
Anthropic CMA  →  claude-managed-agents  →  islo-web-api (existing)  →  bear-agent / CLH
```

- **No changes** to `islo-web-api` or `islo-frontend`
- Sandboxes are created via your Islo API key
- Egress and credential injection use existing **gateway profiles**

## Prerequisites

1. An Islo account with API access
2. An Anthropic **Self-managed** CMA environment
3. A pre-configured Islo **gateway profile** with Anthropic integration rules

## Quick start

### 1. Configure Islo (one-time)

1. Connect Anthropic: `islo login --tool anthropic` or via the Islo dashboard Integrations page
2. Create a gateway profile allowing required hosts (`api.anthropic.com`, GitHub, npm, etc.)
3. Create an API key in Islo

### 2. Configure Anthropic

1. Create a Self-managed environment in the [Claude Platform Console](https://platform.claude.com/workspaces/default/environments)
2. Add a webhook pointing to `https://<your-host>/webhooks`
3. Save `ENVIRONMENT_ID`, `ANTHROPIC_ENVIRONMENT_KEY`, `ANTHROPIC_API_KEY`, and `WEBHOOK_SECRET`

### 3. Deploy this control plane

```bash
cp .env.example .env
# Edit .env with Anthropic + Islo credentials

npm install
npm run dev          # local
# or
docker compose up --build
```

### Required environment variables

| Variable | Description |
|---|---|
| `ENVIRONMENT_ID` | Anthropic self-managed environment ID |
| `ANTHROPIC_ENVIRONMENT_KEY` | Environment key (`sk-ant-oat01-...`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `WEBHOOK_SECRET` | Standard Webhooks signing secret |
| `ISLO_API_KEY` | Islo API key |
| `ISLO_API_BASE_URL` | e.g. `https://api.islo.dev` |
| `ISLO_GATEWAY_PROFILE` | Gateway profile name for CMA sandboxes |
| `ISLO_RUNNER_IMAGE` | Default: `ghcr.io/islo-labs/islo-runner-cma:latest` |

## Session lifecycle

1. Anthropic sends `session.status_run_started` → control plane polls work queue
2. Control plane creates an Islo sandbox (`runtime: clh` via existing API)
3. Sidecar dispatcher answers CMA stock tools (`bash`, `read`, `write`, etc.) via sandbox exec/files API
4. Heartbeat loop holds the work-item lease
5. On idle/terminate → snapshot workspace via existing `POST /snapshots`
6. Resume on same session ID restores from snapshot

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/webhooks` | Anthropic webhook ingress |
| GET | `/sessions` | Local session registry |

See [docs/egress.md](docs/egress.md) for gateway profile setup.

## Runner image

The `islo-runner-cma` image lives in [`bear-agent/images/islo-runner-cma`](../bear-agent/images/islo-runner-cma). It extends `islo-runner` with the Anthropic `ant` CLI.

## Development

```bash
npm run typecheck
npm test
npm run build && npm start
```

## License

MIT
