# Network access and credentials

CMA agents need outbound network access — calling Anthropic, cloning repos, installing packages, and so on. Islo lets you **control what they can reach** and **inject credentials without putting secrets inside the sandbox**.

## Why this matters

Without controlled egress, an agent running arbitrary code could exfiltrate data or reach services it shouldn't. Islo sandboxes route outbound traffic through a **gateway** that enforces your rules and attaches credentials in flight. The sandbox process never receives the raw API key.

## Setup (one-time)

### 1. Connect Anthropic

Link your Anthropic account so Islo can inject API credentials on allowed requests:

```bash
islo login --tool anthropic
```

Or use the Islo dashboard → **Integrations** → Anthropic.

### 2. Create a gateway profile

A gateway profile is a named set of network rules. Create one for CMA sessions — for example `cma-default`.

**Minimum rule:** allow `api.anthropic.com` and attach the Anthropic integration so requests are authenticated automatically.

**Common additions:**

| Host | Why |
|---|---|
| `*.github.com` | Clone private repos, use GitHub API |
| `registry.npmjs.org` | Install npm packages |
| `pypi.org` | Install Python packages |

Configure profiles in the Islo dashboard or via the Islo CLI. See [Islo gateway documentation](https://docs.islo.dev) for rule syntax.

### 3. Tell the control plane which profile to use

In your `.env`:

```env
ISLO_GATEWAY_PROFILE=cma-default
```

Every sandbox created for a CMA session will use this profile.

## How it works

```
Agent in sandbox  →  outbound request  →  Islo gateway  →  upstream service
                                              ↑
                                    your allowlist rules
                                    + injected credentials
```

1. The agent makes a request (e.g. to `api.anthropic.com`).
2. Traffic passes through the Islo gateway.
3. The gateway checks your profile rules — allow or deny.
4. For allowed requests to integrated services, the gateway attaches the real credential. The sandbox only ever saw a placeholder.

## Tips

- Start **deny-by-default** and allow only what your agents need.
- Use separate profiles for different agent types (e.g. read-only vs full internet).
- Rotate API keys in Islo Integrations — sandboxes pick up changes without redeploying the control plane.
