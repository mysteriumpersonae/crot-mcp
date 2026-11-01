# Agents & Tokens central workspace

The Agents route alone uses the two-column Inbound MCP / Outbound AI composition
from the owner-provided 5.png reference. Desktop columns are 1fr 1fr with a 24px
gap; narrow layouts stack them. The sidebar and shared header are unchanged.
Agents no longer shows the ten workspace navigation tabs or the raw vertical
provider/token forms. Existing access grants and token administration remain in
a collapsed advanced section rather than being removed.

## Inbound MCP: truthful URLs and credentials

Relay URL is the service-supplied paired resource URI, not a fabricated example.
Production uses https://mcp.crot.network/d/<deviceId>/mcp. An unpaired device shows
an empty read-only field and a pairing action; it never invents /relay/<id>.

The existing scoped ClientTokenRegistry issues local HTTP MCP bearer tokens. They
are **not** cloud relay OAuth credentials. The UI explains the distinction. Issue
and rotation require confirmation and use tokens.issue/tokens.rotate; the existing
registry audits before activation, stores only hashes, and invalidates old token
sessions. A new secret is kept only in the current screen's input and is never
read back after navigation. Eye and clipboard actions work only for newly issued
values. TTL in days and scopes stay under Advanced token parameters.

Notion / Claude / n8n tiles open client-specific instructions with clipboard
configuration and command actions when a real paired URL exists. Without pairing
they explain the prerequisite and offer the installed local Claude configuration.
Claude Desktop uses an mcp-remote stdio adapter; npx/mcp-remote is a prerequisite,
not bundled or silently installed. Notion/n8n JSON is explicitly a setup recipe,
not a fictitious import format. They use client UI + OAuth; their curl command is
explicitly a diagnostic OAuth challenge probe, not an invented installation CLI.
Sources: Notion Help, MCP connections for Custom Agents; n8n MCP Client Tool docs.

## Outbound AI

Cloud Save & Test uses the existing encrypted CrotService provider vault followed
by an actual guarded model-list request. Only a successful nonempty inventory
produces Connected and working. Persisted checkedAt, connectionStatus and default
model contain no credentials. Credential or endpoint changes invalidate previous
success. A stale test cannot mark a replacement configuration connected. Failures
are sanitized; no API response/key is echoed into errors.

OpenAI and Anthropic retain their adapters. Gemini and OpenRouter use their actual
OpenAI-compatible model-list and chat-completion endpoints; Gemini's official
OpenAI compatibility documentation confirms bearer authorization and /models.
Unified Chat discovers saved providers/models on navigation and honors their
persisted default model. No connection is described as an independently routable
agent solely because an account exists.

Local Models defaults to http://localhost:11434 and probes its OpenAI-compatible
/v1/models interface through the same Core authorization path. Custom compatible
base paths are supported. A native OpenCode control server is not advertised as
an OpenAI chat API. Default model and this note stay under advanced settings.

Workspace rows use accounts.list/configure/connect/check/disconnect/cancel. Notion
uses the existing registered CROT OAuth broker; GitHub supports configured OAuth
application credentials. Electron validates the generated authorization destination
and opens the system browser. Account credentials remain in the existing OS secret
store, and disconnect invokes actual revocation/removal, not a UI-only toggle.

## Verification

The --agents real Chromium scenario exercises actual CrotService token issue,
cancelled issue, same-record rotation, clipboard/reveal, hash-only storage and
redacted audit; HTTP fixture model tests, persisted defaults/status, failure status
and a chat response using a saved provider. Desktop/mobile screenshots use shipped
assets. Separate paired URL presentation fixtures exercise integration recipe/copy
modals without implying a live paired relay or vendor OAuth success. Existing
service streaming/approval/cancellation and Home/Chat regressions remain gates.
