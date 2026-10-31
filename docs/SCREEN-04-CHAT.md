# Unified Chat central workspace

Chat has no workspace-tools strip, repeated page heading, global stale notice or
API credential form. Provider configuration lives in Agents & Tokens and still
uses audited owner RPCs and the secret vault. Sidebar navigation and Home layout
are unchanged; the shared notification counter has a centered circular badge.

The welcome state has four quick prompts. A quick prompt fills the draft but never
submits without a send action. The composer uses a subtle gray outer hover/focus
border, no inner textarea outline, and a circular send/stop button. File attachment,
removal and Ctrl/Cmd+Enter remain supported. Limits remain four UTF-8 text or
PNG/JPEG/WebP files, 96 KB total, validated by ChatRuntime.

## Connection groups

- Left: **Connected Platforms**, remote workspaces such as GitHub, Notion or
  YouTube. Its footer opens account management.
- Right: **Skills**, capability providers such as FFmpeg, Remotion or ElevenLabs,
  custom skills and non-platform MCP tool providers. Its **Add skill** footer opens
  the existing custom-skill editor. A cloud API can supply a skill; transport alone
  does not make it a remote platform.
- Bottom: **Agents**, configured chat transports plus all connected, non-revoked
  local/remote clients returned by agents.list and active agent-provider connectors.

Group icons come from actual inventory with role-appropriate fallbacks. Custom
skills use a skill icon even when their name contains a platform brand; platform
logos such as Notion and YouTube are not decorative skill footer icons.

Native popovers provide keyboard navigation, selected checks and light dismissal.
Inventory refreshes from accounts.list, connectors.list, skills.list, mcpServers.list
and agents.list. Disabled/disconnected entries are excluded. Selections survive
language rerenders and are removed only after refreshed inventory confirms removal.
Selections add non-secret prompt context; they do not create new model-callable
connector RPCs. Canonical chat tools are separately opt-in and Core-authorized.

OpenAI, Anthropic (Claude) and Local HTTP remain the supported direct chat
transports. Registered Notion/OpenCode/other CROT clients are visible with honest
connection details, not falsely routable LLM transports. Clicking those clients
opens details/configuration rather than dispatching a fake chat request. The Other
menu lists returned models and connected clients. Conversation blocks remain
visible across successive sends in the renderer session, not durable chat storage.

Verification uses shipped assets in Chromium and an isolated CrotService: RU/EN,
desktop/mobile bounds, menu role separation, matching icons, selection persistence,
composer/button/badge geometry, file attach/remove, real HTTP streaming, guarded
file writes, allow once/project, remembered grants and cancellation. Group fixtures
exercise presentation only; screenshots do not imply live vendor authentication.
Home, account and other service scenarios remain regression gates.
