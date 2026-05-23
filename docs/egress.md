# Egress and credentials for CMA on Islo

CMA sessions need outbound access with zero-trust credential injection. Islo provides this via gateway profiles — no changes to `islo-web-api` are required.

## Setup (one-time per tenant)

### 1. Connect Anthropic integration

```bash
islo login --tool anthropic
```

### 2. Create a gateway profile

Minimum hosts:

| Host pattern | Purpose |
|---|---|
| `api.anthropic.com` | Anthropic API (`anthropic` provider for token injection) |
| `*.github.com` | Git / GitHub API (optional) |
| `registry.npmjs.org` | npm (optional) |

### 3. Configure the control plane

```env
ISLO_GATEWAY_PROFILE=cma-default
```

Every CMA sandbox is created with this profile. Phantom tokens + Envoy MITM + `islo-gateway` inject credentials without exposing secrets inside the CLH microVM.

## Architecture

```
CLH microVM  →  Envoy MITM  →  islo-gateway  →  upstream
                      ↑
              gateway profile + integration tokens
```
