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

The server domain is explicitly https://mcp.crot.network. This alone is not a
personal MCP endpoint. The paired service supplies the complete URL, currently
https://mcp.crot.network/d/<deviceId>/mcp. The UI never invents a /relay/<id> route.

The owner must sign in, pair this device, have a current cloud entitlement and
enable remote access. Then copy the full personal MCP URL into the client's
Custom MCP settings and complete OAuth. The UI has actual pairing and remote-mode
controls plus a step-by-step guide. A build without identity/pairing support says
so rather than showing a fake URL or success. Cloud availability/entitlement is
not granted by local sign-in alone.

Notion Custom Agent: Settings → Tools & Access → Add connection → Custom MCP
server, full server URL, OAuth, choose tools, Connect. An administrator may first
need to enable/approve custom MCP servers. Notion also supports header auth, but
CROT's deployed relay contract is OAuth, not the local bearer token below.

The separately collapsed Local HTTP access section shows the actual running
loopback MCP endpoint from CrotService (empty if HTTP is not running) and the
scoped ClientTokenRegistry bearer token. Hosted clients cannot reach localhost.
Issuance/rotation uses confirmation and existing audited hash-only registry;
rotation invalidates old local sessions. New secrets are visible/copyable only
once. Advanced TTL/scopes and existing connected-client grants are preserved.

Official integration recipes remain for Notion/Claude/n8n. They use the real
paired URL, explicit OAuth prerequisites and working clipboard actions. Notion
and n8n JSON is a setup recipe, not an import/workflow format; curl is labeled a
diagnostic probe, not a fictitious installation command.

## Outbound: only models/agents that CROT can actually invoke

No GitHub repository, page/database OAuth account, or data connector is configured
in this column. Existing data connections remain in Accounts/Connected Platforms.

### Cloud LLM

OpenAI/Anthropic/Gemini/OpenRouter use their actual model-list and generation APIs.
Save & Test stores credentials in the existing encrypted vault, checks an actual
nonempty inventory via Core and persists check time/status/default model.
Endpoint/key/username changes invalidate prior verification; model-only updates
retain it. All providers use the same guarded Core network path.

### Local Models

Ollama defaults to http://localhost:11434 and uses /v1/models plus its
OpenAI-compatible chat API. LM Studio defaults conventionally to localhost:1234.
The URL is configurable. OpenCode is NOT treated as an OpenAI-compatible local
model endpoint; it is in Workspaces with its native adapter.

### Workspaces

- **OpenCode server**: start `opencode serve --hostname 127.0.0.1 --port 4096`.
  Optional `OPENCODE_SERVER_PASSWORD` uses HTTP Basic; username defaults to
  `opencode` (custom username supported). Check `/global/health`, then `/provider`;
  list models from connected providers only. Chat creates `/session` and posts
  `/session/{id}/message` with providerID/modelID and text parts. Stop/failure
  attempts `/session/{id}/abort`. No fabricated `/v1/chat/completions` or CLI
  subprocess is used to invoke OpenCode.
- **Notion Agents API (public beta)**: use a PAT or connection token with agent
  interaction capability and access to a published Custom Agent. This credential
  is separate from Notion data OAuth. Discover active accessible Custom Agents
  through paginated `/v1/agents/query`. Chat posts `/v1/sessions`, polls session
  state and reads paginated `agent.message` events in sequence. Uses
  `Notion-Version: 2026-03-11`. Stop/failure attempts `/sessions/{id}/cancel`.
  Required-action sessions are not auto-approved; they fail closed with cancellation.

Native workspace agents run under their own server-side permissions and tools.
Connecting requires explicit acknowledgement. CROT chat tool grants are not
forwarded or silently ignored. Workspace adapters accept text (including text
attachments); image attachments or selected CROT tools are rejected with guidance.
Each CROT turn currently creates a new remote session, consistent with the existing
single-turn model transport. Cross-turn remote session continuation is not claimed.
Remote cancellation is best effort through the same Core policy; no unguarded HTTP
fallback. Bounded inventories, pagination, output, timeouts and redacted errors apply.

Native provider credentials use the chat vault and can be removed with
`chat.remove`; this does not disconnect unrelated data-platform accounts. Saved
native model/agent inventories immediately appear as callable choices in Unified
Chat, with default selection and human-readable model/agent names.

## Sources checked for this revision

- https://opencode.ai/docs/server
- https://opencode.ai/docs/sdk/
- https://developers.notion.com/guides/notion-agent-apis/quickstart
- https://developers.notion.com/reference/notion-agent-apis/query-session-events
- https://developers.notion.com/reference/notion-agent-apis/cancel-session
- https://www.notion.com/help/mcp-connections-for-custom-agents

## Verification boundary

Real Chromium/CrotService tests cover guarded requests, encrypted credential
configuration, HTTP Basic/Bearer headers and Notion version, native inventory,
model/agent selection, successful answers from both native API fixtures, removal,
core model regression, token rotation/audit, custom dropdowns and conditional
accordion fit at 1280x800. Unit tests exercise pagination, inactive provider/agent
filtering, response ordering, cancellation and fail-closed required actions.
Fixtures follow published contracts; no live vendor subscription, production
paired relay, or actual account authorization is falsely claimed verified.
