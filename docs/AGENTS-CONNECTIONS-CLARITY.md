# Agents connection clarity

Baseline: `06016a1` (PR #49). This change is source implementation and repository verification, not live provider or remote-relay qualification.

## Direction and authentication

- **Inbound MCP** supplies data an external client needs to reach CROT. Only the device's returned HTTPS resource URI is copyable as the remote server URL. No default domain is presented as a personal endpoint.
- The implemented remote relay uses OAuth. A local HTTP Bearer token does not authorize that relay. If account/device pairing is unavailable in the build, the UI reports that limitation and does not offer a nonfunctional pairing button.
- Local HTTP MCP has its own server URL and scoped Bearer-token controls. A hosted client cannot reach this computer's localhost.
- Instruction-only “Official integrations” cards were removed. No official partnership or external-client acceptance is claimed.

## Outbound AI

- Chat lists models discovered from configured callable providers; inbound MCP clients and connector credentials are not chat transports.
- River has a named OpenAI-compatible adapter using `https://api.river.ai/v1`. A generic OpenAI-compatible entry supports servers exposing `/models` and `/chat/completions`. Neither a stored key nor the bundled endpoint implies a working connection.
- OpenCode and Notion Agents retain their native workspace adapters. Data workspace connections remain separate from agent invocation.
- A successful Save & Test verifies model inventory, not a successful generation or every model's tool capability. Empty inventories invalidate a previous green status.
- Connection failures preserve only allowlisted code/stage, HTTP status and selected DNS/TLS/socket codes. Provider bodies, credentials, arbitrary messages and URLs are not returned as diagnostics.

## Sessions and layout

- Repeated client names represent independently authorized sessions. Display groups do not merge IDs, grants, logs, revocation or rate limits. Completed owner-chat runs are detached instead of remaining connected.
- Outbound sections are mutually exclusive, have stable summary geometry and animated details content. The parent column does not acquire a transient scrollbar; long section bodies scroll inside a bounded area. Reduced-motion preference disables transitions.

## Qualification limits

The owner's River key and installed desktop instance are not available to the repository tests. The original live River failure cannot be attributed to credentials, permissions, DNS or TLS without the new diagnostic from that instance. Local HTTP fixtures qualify transport/error handling only, not live River, Notion, OpenCode or public-relay availability. Screenshots with local fixture models are test evidence, not production connection claims.
