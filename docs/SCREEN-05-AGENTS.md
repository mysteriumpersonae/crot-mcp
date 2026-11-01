# Agents & Tokens: MCP admission and callable AI only

Only the central Agents route is changed. Sidebar/shared header remain unchanged.
Two desktop columns use 1fr 1fr and a 24px gap. Both columns have usable vertical
scrolling as a fallback, not clipped content. Outbound accordions start with Cloud
open. Opening a section closes other open sections only when the column cannot
fit them. Resize and nested advanced expansion re-evaluate fit. An unusually tall
single section remains scrollable; essential controls are never hidden by overflow.
Inputs and custom select popovers share Unified Chat control geometry, menu rows,
keyboard navigation, and subtle gray input focus treatment.

## Inbound: connecting CROT as Custom MCP

**Domain:** `https://crot.network` — one shared public relay for all users.

The owner must sign in to crot.network (Email/OTP, Google OAuth, or GitHub OAuth —
no WorkOS dependency), pair this device, have a current cloud entitlement and
enable remote access. The relay runs on crot.network/d/<deviceId>/mcp; the
personal URL is shown only after successful pairing. The UI never invents a URL
before pairing completes.

**Pairing URL format:** `https://crot.network/d/<deviceId>/mcp`

**Authorization:** OAuth 2.1. The CROT auth server is `https://auth.crot.network`.
An external client (Notion, Claude, n8n) receives a token via the OAuth flow —
not a manually copied Bearer token. For services that require a pre-shared Bearer
token (local testing), the Local HTTP section supplies one.

### Notion Custom Agent setup
Settings → Tools & Access → Add connection → Custom MCP server:
- Server URL: `https://crot.network/d/<your-deviceId>/mcp`
- Authorization: OAuth 2.1
- Choose tools → Connect

An administrator may first need to enable custom MCP servers for the workspace.

### Left column behavior
- Yellow warning banner removed once the user has signed in
- deviceId and relay URL generated automatically after pairing
- Bearer Token shown as ••••••• with eye / copy / regenerate buttons
- Integration recipe cards (Notion / Claude / n8n) with copy-ready data

## Outbound: only models/agents that CROT can actually invoke

No GitHub repository, page/database OAuth account, or data connector is configured
in this column. Existing data connections remain in Accounts/Connected Platforms.

### Network auto-allow
Built-in AI provider hosts are in the default `permissions.network.allow` list:
`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`,
`openrouter.ai`, `api.river.ai`, `api.notion.com`, `127.0.0.1:11434` (Ollama),
`127.0.0.1:1234` (LM Studio), `127.0.0.1:4096` (OpenCode).

When an owner saves a provider via `chat.configure`, `ProductRuntime` additionally
calls `host.addNetworkAllow(PROVIDER_NETWORK_HOSTS[provider])` to ensure the host
is reachable even if the user has a custom config that omits the default list.

### Error diagnostics
`providerDiagnostic` now returns distinct codes:
- `NETWORK_GUARD_BLOCKED` — ExecutionGuard blocked the request (PERMISSION_DENIED)
- `AUTH_INVALID_KEY` — server returned HTTP 401 or 403
- `LOCAL_SERVER_OFFLINE` — ECONNREFUSED on a loopback address
- `OPERATION_FAILED` — other network or protocol error

The UI maps these to actionable messages without exposing credentials or URLs.

### Cloud LLM
OpenAI/Anthropic/Gemini/OpenRouter/River use their actual model-list and generation
APIs. Save & Test stores credentials in the existing encrypted vault, checks an
actual nonempty inventory via Core and persists check time/status/default model.

### Local Models
Ollama defaults to http://127.0.0.1:11434 (explicit IP required for loopback allow).
LM Studio defaults to 127.0.0.1:1234. OpenCode is in Workspaces.

### Workspaces
- **OpenCode server**: native adapter at http://127.0.0.1:4096
- **Notion Agents API**: PAT or connection token with agent interaction capability

## Verification boundary
Real Chromium/CrotService tests cover guarded requests, encrypted credential
configuration, HTTP Basic/Bearer headers, network auto-allow on chat.configure,
NETWORK_GUARD_BLOCKED diagnostic, native inventory, model/agent selection and
removal. Unit tests exercise pagination, inactive provider/agent filtering,
response ordering, cancellation and fail-closed required actions.
