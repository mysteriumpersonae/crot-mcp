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

**Authorization (self-registered URL, the default):** the client token generated on
this screen (CrotService stores only its SHA-256 digest). MCP clients present it in
the form they support; every form carries the same token:
- `Authorization: Bearer <token>` (Notion Custom MCP: Authentication → Bearer token);
- Basic Auth: username `crot`, password `<token>`;
- an API-key header: `X-API-Key: <token>` (`Api-Key` and `X-CROT-Token` work too);
- OAuth 2.0: Client ID `crot-<deviceId>`, Client Secret `<token>`. The client
  discovers the endpoints from the MCP URL; the owner approves the request on the
  crot.network consent page (authorization code + PKCE), or the client uses the
  `client_credentials` grant. See [RELAY.md](RELAY.md).

The details «Other authorization methods (Basic, API Key, OAuth)» under the token
show these values with copy buttons. **Paired devices** keep OAuth 2.1 through
`https://auth.crot.network` (Bearer access tokens only).

### Notion Custom Agent setup
Settings → Tools & Access → Add connection → Custom MCP server:
- Server URL: `https://crot.network/d/<your-deviceId>/mcp`
- Authentication: Bearer token (paste the generated token)
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
- `FREE_USAGE_LIMIT` — OpenCode Zen refused anonymous free use (HTTP 429 `FreeUsageLimitError`)
- `FREE_TIER_LIMIT` — local OpenCode reached OpenCode's own free tier limit (its session
  status turned to a retry with `free_tier_limit`, or a retry minutes ahead)
- `OPENCODE_NOT_INSTALLED`, `OPENCODE_START_FAILED`, `OPENCODE_START_REFUSED` — the local
  OpenCode bridge could not be used (no CLI, the server did not become healthy, the
  emergency stop or an explicit runtime deny of process.start)
- `OPERATION_FAILED` — other network or protocol error

A failed chat turn shows a fixed message chosen by the provider's HTTP status (401,
403, 404, 429, 400/422, 5xx, free usage limit, local OpenCode), never the provider's own text.

The UI maps these to actionable messages without exposing credentials or URLs.

### Cloud LLM
OpenAI/Anthropic/Gemini/OpenRouter/River use their actual model-list and generation
APIs. Save & Test stores credentials in the existing encrypted vault, checks an
actual nonempty inventory via Core and persists check time/status/default model.

**OpenCode (Free & Zen)** (`https://opencode.ai/zen/v1`): the API key field and
Save & Test are always shown; the key is optional (empty = free models). Before
the first check the form lists OpenCode Zen's free models; Save & Test loads the
live inventory (`/models`): without a key the free models only, with a key every
model CROT can talk to (chat completions, and Claude/Qwen over `/messages`; models
that need the Responses or Gemini API are left out). Without a key Save & Test also
sends one tiny completion, so a refused anonymous use (OpenCode's free usage limit
per network address) is reported at once: enter a Zen API key from
`opencode.ai/zen`, or use OpenCode in Workspaces (`opencode serve`).

How CROT reaches OpenCode Zen, in this order (`zenRoute`):
1. the key saved in the form (vault);
2. the owner's own OpenCode key: `OPENCODE_API_KEY`, else an `"type": "api"` entry
   (`opencode`, `zen` or `console`) of OpenCode's `auth.json` (`$XDG_DATA_HOME/opencode`,
   `~/.local/share/opencode`, on Windows also `%LOCALAPPDATA%\opencode` and
   `%USERPROFILE%\.local\share\opencode`, then `~/.config/opencode`). Read only; the key
   is sent only to OpenCode Zen (`https://opencode.ai`, or a loopback test server), never
   stored, logged, returned to the UI or passed to a child process. The UI shows its source
   ("Key from OpenCode (auth.json)");
3. without a key, through **local OpenCode**: the owner's `opencode serve` on
   127.0.0.1:4096 when it answers without a password, else CROT's own bridge
   (`OpenCodeBridge`): `opencode serve --hostname 127.0.0.1 --port 4096` (any free port when
   4096 is taken) with a random `OPENCODE_SERVER_PASSWORD` (HTTP Basic), the allowlisted
   child environment plus `OPENCODE_*` (no CROT service secrets) and the empty, CROT-owned
   working directory `<state>/opencode-chat`. It starts on Save & Test or the first chat turn
   ("Auto-connect via local OpenCode"), never when the UI only lists models, and stops when
   the provider is removed, on the emergency stop and when CROT exits (a SIGKILLed service
   can leave it running). Its start/stop/exit are audited (`opencode_bridge`, no secrets);
4. anonymously (OpenCode not installed): Zen usually refuses clients other than OpenCode
   with `FREE_USAGE_LIMIT`; the form then shows "Get a free or paid API key at
   opencode.ai/zen" and the install command `npm i -g opencode-ai` with a copy button.

Turns through local OpenCode are model-only: a new OpenCode session per turn with every
OpenCode tool turned off (`tools: {"*": false, …}`), the session deleted afterwards; CROT
tools and images need a Zen key (`local_text_only`). While a turn is pending CROT watches
`/session/status`: OpenCode retries a refused free model instead of failing, so a retry with
`free_tier_limit` (or minutes ahead) aborts the turn at once with `FREE_TIER_LIMIT`. A free
model that Zen refuses (429/403) before any answer is answered once more through local
OpenCode. Every direct Zen request carries `User-Agent: CROT/<version>` and a random session ID
(`x-opencode-session`, `x-session-id`) that stays the same within a chat thread.

Before the first check the picker shows a bundled catalog: free models (`big-pickle`,
`glm-5.3-flash-free`, `deepseek-v4-flash-free`, `minimax-m2.5-free`, `mimo-v2-pro-free`,
`qwen3.6-plus-free`, `nemotron-3-ultra-free`, labelled "(free)") and models that need a key
(`glm-5.3`, `glm-5.3-flash`, `deepseek-v4-pro`, `claude-sonnet-4-6`, `gpt-5.5`, `kimi-k2.5`,
labelled "(Zen / Go)"). OpenCode rotates its free models, so the live inventory (Zen's
`/models`, or local OpenCode's `/provider`) replaces the catalog after Save & Test.

`opencode.status` reports `{available, installed, installCommand, keySource?, server?:
{url, managed, version?}}` (never a key or password); `opencode.stop` stops CROT's own server
(refused while a generation runs). In Electron, links of the Agents screen open in the
system browser only for allowlisted HTTPS hosts (`opencode.ai`, Notion, Claude, n8n).

### Local Models
Ollama defaults to http://127.0.0.1:11434 (explicit IP required for loopback allow).
LM Studio defaults to 127.0.0.1:1234; preset buttons fill either URL. Test loads
the server's models into the model selector. OpenCode is in Workspaces.

### Workspaces
- **OpenCode server**: native adapter at http://127.0.0.1:4096. **Start and connect
  OpenCode** (after a warning) starts CROT's own server as above and connects to it
  (`managed: true`, no stored password); its status line shows "Running on 127.0.0.1:<port>"
  and Stop. OpenCode's agents then work in the open project (`x-opencode-directory`) with
  OpenCode's own permissions; CROT tool grants are not forwarded and CROT never approves
  their actions. A server the owner runs in a terminal is used with Save & Test as before.
- **Notion Agents API**: PAT or connection token with agent interaction capability

## Verification boundary
Real Chromium/CrotService tests cover guarded requests, encrypted credential
configuration, HTTP Basic/Bearer headers, network auto-allow on chat.configure,
NETWORK_GUARD_BLOCKED diagnostic, native inventory, model/agent selection and
removal. Unit tests exercise pagination, inactive provider/agent filtering,
response ordering, cancellation and fail-closed required actions.
