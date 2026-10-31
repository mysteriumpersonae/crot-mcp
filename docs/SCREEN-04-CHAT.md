# Unified Chat central workspace

Only Chat's central content is changed. Shared sidebar navigation and the Home
layout are unchanged. Chat has no workspace-tools strip, repeated page heading,
global stale notice or API credential form. Provider configuration lives in
Agents & Tokens and still uses the existing audited owner RPCs and secret vault.

The welcome state has a soft blue conversation icon and four quick prompts. A
quick prompt fills the draft and replaces the welcome with the conversation area;
it never submits without a send action. The composer stays at the bottom, with
file attachment/removal, Ctrl/Cmd+Enter and a send/stop button. Existing attachment
limits apply: four UTF-8 text or PNG/JPEG/WebP files, 96 KB total. Unsupported or
invalid attachments remain rejected by ChatRuntime.

Web-service and connector/skill disclosures are native light-dismiss popovers
with keyboard navigation, selected checks and an Add connection footer. Inventory
comes from accounts.list, connectors.list, skills.list and mcpServers.list.
Disconnected/restricted accounts and disabled/unverified connectors are not
presented as active. Configured custom skills remain distinguishable from active
connections. These selections add non-secret context to the prompt; they do not
create new model-callable connector RPCs or bypass permissions. Canonical chat
tools are separately opt-in inside the skills disclosure and remain guarded by
Core. Tool output uses compact disclosure cards, approvals stay inline, and
stopping generation cancels pending requests through the existing service path.

Cloud-agent pills are based only on configured providers whose model inventory
can be fetched. OpenAI, Anthropic (Claude) and Local HTTP are the service's supported
chat transports. Notion/OpenCode accounts or MCP clients are not falsely advertised
as independent LLM transports. The Other menu lists every returned model and links
to configuration. Missing providers are explained inside that disclosure, not by
adding a setup form to the conversation. Conversation blocks remain visible across
successive sends within the renderer session; this is not durable chat storage or
a change to ChatRuntime's existing per-run model context.

Verification uses the shipped assets in real Chromium and an isolated CrotService:
RU/EN welcome, desktop/mobile bounds, both menus, quick prompt, file attach/remove,
real HTTP provider streaming, guarded file write, allow once/project, subsequent
project grant and cancellation of a pending ask. Home, account and other service
scenarios remain regression gates. No live third-party account access is implied
by fixture screenshots.
