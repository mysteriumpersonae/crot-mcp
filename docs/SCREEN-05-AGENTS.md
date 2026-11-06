# Agents & Tokens: MCP admission and callable AI only

Only the central Agents route is changed. Sidebar/shared header remain unchanged.
Two desktop columns use 1fr 1fr and a 24px gap. Both columns have usable vertical
scrolling as a fallback, not clipped content. The outbound column has two accordions,
**Cloud LLM** (open first) and **Local models**; exactly one is open at a time
(opening one closes the other). An unusually tall section remains scrollable;
essential controls are never hidden by overflow. Both columns use one compact form
style: 13px field labels, 12px notes, 16px gaps inside a card; logical groups (the
remote tunnel, the OpenCode Zen key hint and installation, the local server's setup
hint) are shaded panels (`--bg-sunken`), saved connections are bordered lists with
their actions on the row. Every action appears once: Disconnect lives only on the
row of the connection it removes. Inputs and custom select popovers share Unified
Chat control geometry, menu rows, keyboard navigation, and subtle gray input focus
treatment.

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
- `LOCAL_SERVER_OFFLINE` — nothing listens at the address (ECONNREFUSED, from the network
  guard or from fetch's socket error)
- `NO_MODELS` — the server answered but lists no models (`reason: "no_models"`)
- `TIMEOUT` — no answer in time (fetch's `TimeoutError`, a connect timeout; `networkCode`
  `ETIMEDOUT`)
- `FREE_USAGE_LIMIT` — OpenCode Zen refused a free model (HTTP 429 `FreeUsageLimitError`).
  Zen serves its free models only to OpenCode itself; an API key is for the paid models and
  does not unlock the free ones. The UI says so: "OpenCode Zen refused the free model (free
  usage limit): free models work only inside OpenCode, an API key does not unlock them.
  Connect through local OpenCode (Auto-connect), or choose a paid model with an OpenCode Zen
  API key."
- `FREE_TIER_LIMIT` — local OpenCode reached OpenCode's own free tier limit (OpenCode 1.x:
  its session status turned to a retry with `free_tier_limit`, or a retry minutes ahead;
  OpenCode 2: a refused generation with the provider's status 429 or reason `rate_limit`
  whose message names the free usage or the subscription). With `source: "crot"` the refused
  server was the copy CROT installed: it is not signed in to OpenCode, so it has only
  OpenCode's anonymous free allowance, even when the owner's own OpenCode (signed in) still
  works in a terminal. The diagnostic then also carries `owner`: why the owner's own OpenCode
  was not used, as one redacted line (`opencode: not found on PATH or in the usual install
  folders (N places checked)`, or the reason it did not start). The UI says: "OpenCode's free
  limit is reached for CROT's own OpenCode copy (not signed in), because your own OpenCode
  was not found or did not start (see the details). An API key does not unlock free models:
  try again later, or choose a paid model with an OpenCode Zen API key.", followed by
  ` — <owner>`
- `OPENCODE_NOT_INSTALLED`, `OPENCODE_START_FAILED`, `OPENCODE_START_REFUSED` — the local
  OpenCode bridge could not be used (no CLI, the server did not become healthy, the
  emergency stop or an explicit runtime deny of process.start)
- `OPENCODE_V2_UNSUPPORTED` — an OpenCode workspace connection (OpenCode 1.x's session API)
  reached an OpenCode 2 server, which answers those routes with its web app's page ("This
  OpenCode server runs OpenCode 2, whose new server API the OpenCode workspace agent does not
  support yet. Use the Cloud LLM “OpenCode (Free & Zen)”: it works with OpenCode 2.")
- `OPERATION_FAILED` — other network or protocol error (stage `local` when local OpenCode
  answered with an error; `httpStatus: 404` when a local server has no `/models` at the
  address)

A diagnostic of local OpenCode (or of an earlier OpenCode workspace connection) also
carries `model` (the model the request was for) and `detail`: OpenCode's own explanation —
an error answer's `name: data.message (ref …)`, OpenCode 2's `_tag: message`, `{error}` or
text, a refused turn's
`info.error`, a retry's message and link — as one line of at most 300 characters, control
characters removed and anything that looks like a credential (Bearer/Basic values, `sk-…`
keys, long tokens) redacted (`openCodeDetail`). No other provider's text is ever kept.

A failed chat turn shows a fixed message chosen by the provider's HTTP status (401,
403, 404, 429, 400/422, 5xx, free usage limit, local OpenCode); after a failure of local
OpenCode `chat.poll` adds `errorDetail` (`<model> · HTTP <status>: <OpenCode's words>`,
e.g. `glm-5.3-flash-free · HTTP 500: UnknownError: Unexpected server error. … (ref err_…)`;
when CROT's own copy was refused, then ` — ` and why the owner's own OpenCode was not
used), which the chat shows after the fixed message.

The UI maps these to actionable messages without exposing credentials or URLs: the message,
then `[code · HTTP status · network code · model]`, then ` — ` and OpenCode's detail. There
is no generic "connection failed" text. When the tray itself cannot get an answer it says
why (`src/tray/product-failure.ts`): `SERVICE_TIMEOUT` (the service did not answer in time),
`SERVICE_UNAVAILABLE` (the control connection is closed) or `REQUEST_REFUSED` (the service
refused the request; for `chat.*` and `opencode.*` with the service's own one-line reason,
bounded and redacted). Requests that wait for providers or programs — Save & Test
(`chat.testConnection`, which may first start local OpenCode), `chat.models`, `opencode.*`,
projects, connectors, MCP servers, tasks, monitoring and agents — get 180 s on the control
connection instead of 10 s.

### Cloud LLM
OpenAI/Anthropic/Gemini/OpenRouter/River use their actual model-list and generation
APIs. Save & Test stores credentials in the existing encrypted vault, checks an
actual nonempty inventory via Core and persists check time/status/default model.

**OpenCode (Free & Zen)** (`https://opencode.ai/zen/v1`): the API key field and
Save & Test are always shown; the key is optional (empty = free models through local
OpenCode). Save & Test and "Auto-connect via local OpenCode" are the same check: a key
(typed, stored, or the owner's own OpenCode key) goes to the Zen API, which lists every
model CROT can talk to (`/models`: chat completions, and Claude/Qwen over `/messages`;
models that need the Responses or Gemini API are left out); no key goes to local
OpenCode, which lists its models itself (OpenCode 1.x: `/provider`; OpenCode 2:
`/api/model`, its enabled chat models of provider `opencode`, free when no price is above
zero). The model is chosen from that live
list: the saved one while the list still has it, else the first free model (OpenCode's
default, `big-pickle`, first), else the first model. The card is connected (green
"Connected") as soon as the list is there. Through local OpenCode Save & Test then sends
one tiny request with the chosen model (`verify`; OpenCode 1.x at most about 8 s, OpenCode 2
one generation, still running after 20 s counts as accepted): its outcome is returned and
kept as `modelCheck` (`{model, ok, diagnostic?}`), and a refusal (OpenCode's free tier
limit, a model it rejects) is shown as a warning under the status with OpenCode's exact
reason — never instead of the connection. With a key and a free model chosen the check goes
through local OpenCode too (started when needed), like the chat; a local OpenCode that is
missing or does not start is the check's warning ("Connected. The free model needs local
OpenCode: …", with the install button). With a key and a paid model nothing is sent.

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
   the provider is removed, on the emergency stop, when CROT exits (the service's shutdown on
   SIGINT/SIGTERM/SIGHUP, and synchronously on its emergency and `exit` paths) and when the
   tray quits (`opencode.stop`, best effort, at most 2 s). Its PID file
   `<state>/opencode-bridge.pid` (`{pid, port, command, startedAt}`) is written when it starts
   and removed when it stops; a file left behind (CROT killed or crashed) makes the next start
   stop that server first — only after checking that the PID still runs the recorded program
   with `serve --hostname 127.0.0.1 --port <port>` (`/proc`, `ps`, or `Win32_Process` on
   Windows; a reused PID of another program is never touched) — and the file is removed. Its
   start/stop/exit and a stopped left-behind server are audited (`opencode_bridge`, no secrets);
4. never anonymously: Zen refuses clients other than OpenCode without a key. Without a key
   and without OpenCode, Save & Test and a chat turn fail with `OPENCODE_NOT_INSTALLED`
   ("Local OpenCode CLI was not found. Free models work only inside OpenCode: click “Install
   and start OpenCode (1 click)”, or choose a paid model with an OpenCode Zen API key.") and
   Zen is not asked; listing the models shows the bundled
   catalog (`installed: false`). While OpenCode is not installed and the card is not
   connected, the form shows **Install and start OpenCode (1 click)** and the install
   command `npm i -g opencode-ai` with a copy button; the key link is the one of the Zen
   hint above (one link, not two).

**Which OpenCode starts, and why it did not.** The bridge tries the owner's own `opencode`
first. CROT usually runs from the desktop, whose PATH lacks the folders a terminal adds, so
besides PATH it looks in the usual install folders (`~/.opencode/bin`, `~/.local/bin`,
Homebrew and Linuxbrew, `/usr/local/bin`, `/usr/bin`, bun, the npm prefix
(`NPM_CONFIG_PREFIX`, `~/.npm-global`), pnpm, Yarn, Volta; on Windows `%APPDATA%\npm`,
`NVM_SYMLINK`, `Program Files\nodejs`, pnpm, Scoop, WinGet links and Chocolatey) and in
Node version managers (nvm, fnm, mise, asdf, nvm-windows; newest version first, at most 16
folders). Every owner binary found is tried in turn (one file reached through several links
once), each with its own folder first on PATH: an npm launcher (`#!/usr/bin/env node`)
installed with nvm then finds its Node even when the desktop PATH has none. Only then comes
the copy CROT installed (below), which runs with its own `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` under `<state>/opencode-runtime/home`
and so never touches the owner's OpenCode settings, sessions or keys. An OpenCode that failed
to start is skipped while it is unchanged (same path, size and change time) and another one
exists. The server must answer within 60 s: OpenCode 1.x on `/global/health`
(`{healthy, version}`), OpenCode 2 — which answers `/global/health` and every other unknown
GET with its web app's page, even without the password — on `/api/info` (`{version, …}`;
HTTP 401 without the password, so an owner's protected OpenCode 2 on port 4096 is left
alone like a protected OpenCode 1.x). Of its output only the last 4 KB
are kept, and a failed start names the reason in one redacted line (`detail`, the program's
path with `~` for the home folder): `exited with code 1 — <OpenCode's last error line>` (for
example an npm installation without its postinstall script), `HTTP 401 — OpenCode did not
accept CROT's server password`, `no answer within 60 s, last answer HTTP 503 — …`, or the
launch error. An OpenCode that answers `/global/health` with 404 is asked for `--version`:
OpenCode 0.x (older than 1.0, which brought `/global/health` and `/provider`) fails with
`OPENCODE_TOO_OLD` ("Your OpenCode is too old for CROT (version 1.0 or newer is needed).
Install the verified OpenCode into CROT with one click, or update yours with “opencode
upgrade”.", `detail` e.g. `~/.opencode/bin/opencode 0.15.31: CROT needs OpenCode 1.0.0 or
newer`; `opencode v2.2.5` of OpenCode 2 is read as 2.2.5); every other failure with
`OPENCODE_START_FAILED` ("Local OpenCode could not be started. Free models work only inside
OpenCode: install the verified OpenCode into CROT with one click (your own OpenCode stays as
it is), or choose a paid model with an OpenCode Zen API key."). The last failure stays in
`opencode.status` as
`problem: {code, source: "owner" | "crot", version?, detail?}` until a start succeeds, and the
form then shows **Install verified OpenCode into CROT (1 click)** (**Reinstall OpenCode in
CROT (1 click)** when CROT's own copy failed) with "Your own OpenCode stays as it is: CROT
keeps its copy with its own settings and data." The route of a connected card names the
server, who started it ("copy installed by CROT" when CROT's copy serves it) and its
version (`· OpenCode 2.2.5`). While CROT's copy serves, the server and `opencode.status`
keep why the owner's own OpenCode was not used (`ownerProblem: {code, source: "owner",
version?, detail?}`: `OPENCODE_NOT_INSTALLED` with `opencode: not found on PATH or in the
usual install folders (N places checked)`, or the owner's start failure), and the card says
"Your own OpenCode is not used: CROT runs its own copy (not signed in). — <detail>": that
copy has only OpenCode's anonymous free allowance.

**Install and start OpenCode (1 click)** (`opencode.install`, no parameters): the service
downloads OpenCode itself — no terminal, Node.js or npm needed — in the background (one at a
time, 15 min limit): the platform package `opencode-<os>-<arch>[-musl][-baseline]` of
OpenCode 1.19.5 straight from `https://registry.npmjs.org` (about 80 MB), checked against its
pinned sha512 (`OPENCODE_RUNTIME_INTEGRITY`, the registry's published integrity), and only its
`bin/opencode` (`opencode.exe` on Windows) is unpacked into
`<state>/opencode-runtime/bin/<package>-<time>/`. Builds are tried in the order
opencode-ai's postinstall would pick them (the baseline build first on x64 CPUs without
AVX2); the first one that answers `--version` is recorded in `crot-runtime.json`, and earlier
installations are removed (a new folder each time, so a running binary is never overwritten).
Only when the download fails (the registry cannot be reached or answers with an error), the
owner's npm (found on PATH, never in the working directory; allowlisted child environment
plus `npm_config_*`: the owner's registry and proxy) installs the same version with
`npm install --prefix <state>/opencode-runtime --ignore-scripts --no-audit --no-fund
--no-update-notifier --loglevel=error --save-exact opencode-ai@1.19.5`. The UI follows `opencode.status.runtime` (`missing`, `installing` with
`progress` 0–99, `installed` with `version`, `failed` with `opencode_refused`,
`download_failed`, `integrity_mismatch`, `install_failed`, `binary_not_found` or `cancelled`
and a short `detail`) and then runs Save & Test: on the Zen card the same check as
Auto-connect. The emergency stop cancels a running installation, an explicit
runtime deny of starting processes refuses it, and every outcome is audited
(`opencode_runtime`, reason only, no output).

Turns through local OpenCode keep the conversation and the open project. OpenCode's own tools
stay off (`tools: {"*": false, …}`: they would act outside Core) and every turn gets a new
OpenCode session, deleted afterwards; the turn's message carries the whole remembered thread
(up to 120,000 characters, oldest first dropped) and `system` carries the open project's
prompt plus CROT's text tool protocol (`chat-tool-protocol.ts`): the model may answer with
```` ```crot-tool ```` blocks (`{"tool": "...", "arguments": {...}}`, at most 8 per answer, up
to 8 rounds), CROT runs each call through Core exactly like a native tool call (only the
turn's tools; Core policy, approvals and audit apply) and sends the results back as
```` ```crot-tool-result ```` blocks in the next message of the same session. Through local
OpenCode the turn's tools are the read-only project tools (`fs_list_directory`,
`fs_read_file`, `fs_stat`, `project_search_files`) and, when Browser access is
selected, `browser_status`, `browser_tabs_list`, and `browser_page_read`.
These remain subject to Core policy and approval; page content returned to a
model is untrusted. Other CROT tools (`local_read_only_tools`) and images
(`local_text_only`) need a paid model with a Zen key. While a turn is pending
CROT watches `/session/status`: OpenCode retries a refused free model instead of failing, so
a retry with `free_tier_limit` (or minutes ahead) aborts the turn at once with
`FREE_TIER_LIMIT`.

OpenCode 2 keeps no conversation for CROT: every request is one stateless generation (`POST
/api/experimental/generate/text` with exactly `{prompt, model: {providerID: "opencode", id}}`,
at most 120 s) whose prompt carries the `system` text above, `Conversation so far:` (the
remembered thread, then this turn's answers and tool results; beyond 400,000 characters
older tool results of the turn are replaced by a short note) and `New message:`. The tool
protocol, Core and the read-only tools are the same. A refused generation comes back as HTTP
502 `ProviderRequestError` with the provider's own `status` (429 for a rate limit), and that
status is the one reported.

With a key, a free model goes through local OpenCode as well (the owner's, else CROT's copy,
started when needed), because Zen serves free models only to OpenCode itself; a turn with
other tools or images goes to Zen directly. When local OpenCode is missing or does not start,
Zen is asked all the same, and its refusal (429/403 before any answer) reports why local
OpenCode could not serve (`OPENCODE_NOT_INSTALLED`, `OPENCODE_START_FAILED`,
`OPENCODE_TOO_OLD`, `OPENCODE_START_REFUSED`), which says what to do. Paid models always go
to Zen. Every direct Zen request carries `User-Agent: CROT/<version>` and a random session ID
(`x-opencode-session`, `x-session-id`) that stays the same within a chat thread.

Before the first check, and while local OpenCode is not running, the picker shows a bundled
catalog: exactly the free models OpenCode 1.19.5 lists without a key (`big-pickle` — its
default — then `beam-free`, `crouton-alpha-free`, `deepseek-v4.1-flash-free`,
`flint-40b-free`, `glm-5.3-flash-free`, `mimo-v2.6-flash-free`,
`nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `pulse-alpha-free`, labelled
"(free)"). Models that need a key come from Zen's live `/models` only. OpenCode rotates its
free models, so the live inventory (Zen's `/models`, or local OpenCode's `/provider`,
OpenCode's default first) replaces the catalog after Save & Test.

`opencode.status` reports `{available, installed, installCommand, installable?, runtime?:
{state, version?, reason?, progress?, detail?}, keySource?, server?: {url, managed, version?,
api?: 2, source?}, problem?, ownerProblem?}` (never a key or password); `opencode.install` starts the one-click installation and returns the same status;
`opencode.stop` stops CROT's own server (refused while a generation runs; the tray calls it
when it quits). In Electron, links of the Agents screen open in the
system browser only for allowlisted HTTPS hosts (`opencode.ai`, Notion, Claude, n8n).

### Local models
Any OpenAI-compatible server on this computer or in the local network (provider
`Local HTTP`). One **Server URL** field (default `http://127.0.0.1:11434`) and a chip per
popular server that fills its default address: Ollama `:11434`, LM Studio `:1234`,
llama.cpp (`llama-server`) `:8080`, vLLM `:8000`, Jan `:1337`. The chip of the server on the
entered port is highlighted, with a one-line setup hint and its start command (copy button):
`ollama pull llama3.2`, `lms server start`, `llama-server -m model.gguf --port 8080`,
`vllm serve …`; Jan needs its Local API Server and key.

What the owner types is normalized before the check and shown as the exact endpoint CROT
calls ("API endpoint: http://127.0.0.1:11434/v1"): a bare port (`11434`) means
127.0.0.1; a missing scheme means `http://`; `0.0.0.0` (a server's listen address) becomes
127.0.0.1; Ollama's native `/api` path and an empty path become `/v1`; anything after `/v1`
(`/v1/chat/completions`) is dropped. Only http/https without user info is accepted.

**Save & Test** saves the endpoint (its host:port is added to the network allow list, as for
every provider) and the optional API key (vault), then lists `/models` and picks the
default model. Failures say what to do: an invalid address (nothing is saved), nothing
listening at the address (`LOCAL_SERVER_OFFLINE`), no model loaded (`NO_MODELS`), a key
required (HTTP 401/403), no OpenAI-compatible API at the address (HTTP 404: the address
usually ends with /v1), an unknown host, a timeout (a server busy loading a model), each with
`[code · HTTP status · network code]`. The saved server is shown as one row (its name by
port, endpoint and model) with Disconnect, which removes it and its key. OpenCode is not a
local server here: it is the Cloud LLM provider **OpenCode (Free & Zen)**.

### Earlier workspace connections
The Workspaces section (OpenCode server, Notion Agents API) was removed from Agents. Their
native adapters stay in the service, so connections made before keep working in Chat:
they are listed under **Connected providers** as "Workspace agent (earlier connection)"
with Disconnect only (after confirmation; removes the configuration and its vault secret).
A managed OpenCode server of such a connection is still started on demand and stopped with
CROT. New ones are not offered in the UI; `chat.configure` still accepts them. They speak
OpenCode 1.x's session API: with OpenCode 2 (its own server, or CROT's managed one) they fail
with `OPENCODE_V2_UNSUPPORTED`, pointing to the Cloud LLM "OpenCode (Free & Zen)".

## Verification boundary
Real Chromium/CrotService tests cover guarded requests, encrypted credential
configuration, HTTP Basic/Bearer headers, network auto-allow on chat.configure,
NETWORK_GUARD_BLOCKED diagnostic, native inventory, model/agent selection and
removal. Unit tests exercise pagination, inactive provider/agent filtering,
response ordering, cancellation and fail-closed required actions.
