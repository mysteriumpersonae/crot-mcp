# Stage C implementation ledger

Branch: `feat/core-stage-c`, based on merged Stage B PR #6. Stage B exact head
`f8ca3f5` passed 11/11 required checks before merge `7ddc8c0`.

## Implemented first slice (AD-61)

- Shared public pricing: Pro USD 5/month, USD 39/year, founder USD 29/year.
- Named server-validated terms; live Stripe price verification before Checkout.
- Annual/founder subscription IDs resolve to Pro only when server-configured.
- Public portal offers Free/Pro, with explicit separate annual/founder actions.
- Legacy Team subscriptions remain compatible, not newly advertised.
- Serialized Core-owned project registration: Free up to three, verified active
  Pro/trial unlimited; fail before mkdir; existing projects survive downgrade.
- Desktop Subscription section displays verified plan/status/expiry and routes
  changes/cancellation through authenticated hosted billing, not local flags.
- Trial remains seven days, card-backed, monthly. Checkout grants nothing.

Cloud `billing.prices` retains required `pro` (monthly) and legacy `team` IDs.
Optional `proAnnual` and `proFounderAnnual` enable the respective annual offers.
Configure distinct active USD recurring Stripe prices with 500/month,
3900/year and 2900/year cents respectively. Missing annual configuration refuses
Checkout; it never falls back to the monthly price. No live Stripe transaction
has been performed in this implementation environment.

## Still required — not claimed complete

- YouTube, TikTok, X, GitHub, Notion OAuth lifecycle and remote revocation with
  local secret-store cleanup, provider-specific restrictions and diagnostics.
- Human-only publish permits enforced in Core (not just a modal), explicit
  privacy, platform consent/settings, preview and durable send status.
- Provider upload adapters and tests against bypass, replay, account/payload
  substitution and uncertain-send retries.
- Full exact-head 11/11 Stage C CI and real-provider qualification where possible.

PR #7 must stay Draft while these items remain incomplete. Never infer full
Stage C Pass from pricing tests or mocks, and never merge PR #7 automatically.

## OAuth/publication foundation work after 9d967eb (AD-62)

Implemented modules, not yet connected to shipped owner RPC/UI:

- Strict native loopback state/S256/one-use callback with real local HTTP tests.
- Provider-specific token/profile/refresh/revoke adapters and four-state account
  lifecycle, OS-store-only credentials, session abort and verified local deletion.
- Windows Credential Manager FFI and a mandatory Windows-only native round-trip
  test. Linux/macOS HTTP test store doubles are not OS qualification evidence.
- Core two-phase publication, owner-session HMAC confirmation, explicit privacy,
  consent/disclosure checks, durable transitions and replay/uncertain-send refusal.
- Mandatory direct-social-write denial in the generic Core HTTP service, including
  redirect/method-override attempts. Other managed channel integration is pending.

Notion direct authorization is intentionally refused: native PKCE is not
specified by its public API. A reviewed hosted CROT PKCE broker leg is still
needed. No production token exchange, publication or revocation was performed.
This is not a claim of full Stage C completion or a reason to mark PR #7 Ready.

#### AD-63 implementation slice (not Stage C acceptance)

- Added an optional production-domain-only Notion OAuth broker to Relay and a fixed native adapter; no downgrade to direct non-PKCE authorization.
- Tested the actual three-server HTTP round trip, upstream confidential authentication, native PKCE, wrong-state/verifier/redirect rejection, replay, refresh and remote revocation.
- Added strict account metadata restoration and durable restricted state after failed OS-secret cleanup. Account-secret backend selection has its own protected descriptor so unrelated generic-secret migrations cannot silently orphan OAuth credentials.
- Still pending: service/product RPC and shipped account/publishing UI composition, immutable media + production publication adapters, full shipped Chromium positive workflow, native OS credential qualification and new exact-head 11/11 CI. The broker also needs operator app registration/configuration before real Notion sign-in; tests do not substitute for deployment.

#### AD-64 account integration update

The account runtime is now installed in `CrotService`, with strict owner RPC and shipped five-provider account cards. The system-browser destination is independently checked by Electron main; the owner cannot select arbitrary authorization endpoints. An actual service/control-channel/local-provider integration test covers PKCE connect, profile check, remote revocation, verified local cleanup and token-free persisted metadata/audit. Earlier “account RPC/UI not installed” notes above describe the preceding slice, not the current tree.

Remaining Stage C acceptance gaps still include protected avatar rendering and provider-specific restriction diagnostics, service-bound publication composition, immutable media and real platform upload adapters, universal managed-channel bypass coverage, the complete shipped publication-dialog Chromium scenario, and exact-head 11/11 CI/native credential qualification. Do not mark the PR Ready based only on standalone publication-engine tests or the previous `9d967eb` CI.

#### AD-65 immutable-media / platform-protocol slice (not Stage C acceptance)

Added owner-private, bounded SHA-256 media staging and checked Core capture, including negative tests for secret/link sources, unsafe staging, live-source replacement, staging tampering and Full Control access to reserved private state. Added fixed real HTTP publication adapters for YouTube resumable MP4, TikTok inbox drafts and X public text/images; unsupported controls fail explicitly. Added a trusted runtime composing account leases, immutable preview/delivery, audit, asynchronous one-use owner confirmation, restart and fresh mandatory host authorization.

The runtime is not yet installed in shipped CrotService/owner RPC/UI. No real account was connected or post published by this work: protocol tests use actual local HTTP servers and an explicitly injected memory credential store, not external network mocks or native-store qualification. Missing items remain: authenticated owner transport/lifecycle composition, protected avatar delivery/restriction diagnostics, the mandatory publication modal, universal managed-channel anti-bypass evidence, full shipped Chromium positive/negative publication workflow, and new exact-head 11/11 CI. Keep PR #7 Draft; old-head green checks do not certify these additions.

#### Windows qualification checkpoint after `545290d`

The exact-head run completed 10/11 successfully, including Windows Node 20 and Chromium. Windows Node 22 refused the native actor-drain acceptance test because `WTSEnumerateProcessesExW` returned an inventory row without a verifiable user SID (`unknown inventory user SID`). The existing guard refused cleanup rather than treating that partial inventory as proof of absence. The failing annotation is in `appcontainer-process-native.test.ts`; no SID check, test or fail-closed rule is being relaxed. This documents the incident and requests one fresh-runner full qualification through the documentation commit (the connected GitHub tool set has no workflow-rerun operation). A repeat refusal must be investigated rather than retried until green. This is not a Stage C Pass or permission to mark PR #7 Ready.

The fresh `130fb46` run passed Windows Node 22's native SID inventory test without changing its guard. macOS Node 20 then exposed a genuine publication visibility race: the asynchronous list endpoint could show `published` before the durable audit callback completed. The engine is corrected to keep terminal results externally `processing` until its save/audit work finishes; result IDs/errors are not exposed early. A deterministic barrier test holds the terminal audit callback and proves the ordering, rather than weakening the HTTP acceptance assertion or relying on a timing retry. A new-head full qualification is required for this fix.


#### AD-66 service/owner/dialog integration checkpoint (current work)

This supersedes the earlier “publication runtime not installed” notes: it is now
installed in `CrotService`, lifecycle shutdown and emergency stop, a guarded
MCP preparation-only capability, authenticated owner RPC, and the shipped
publication review modal. Real transport-owned session identity binds permits;
JSON never selects an owner, credential, upload endpoint or snapshot path.
Owner disconnect, pending cancellation, active abort, source-file replacement,
account substitution and replay have deterministic integration coverage using
actual local OAuth/platform HTTP. The journal exposes only validated,
content-free publication operation/status identifiers, never post bodies/tokens.

Protected avatar delivery is implemented with provider-pinned HTTPS, no
redirects, raster magic/MIME/dimension/streaming size checks, bounded cache and
local fallback. Dialog avatars bind to the frozen recipient generation.
Snapshot preview uses owner chunks and a renderer SHA-256 check before the
human confirmation button is enabled. Privacy has no default; consent is
unchecked. Unsupported adapter settings are disabled. TikTok inbox metadata
and commercial fields are explicitly finalization reminders, not falsely
advertised direct-post settings.

The first full local regression passed **2449 main tests / 228 platform skips**
and **198 extension tests**; the new real Chromium shipped-dialog scenario
passed, including trusted mouse input, snapshot substitution, privacy/consent
blocking, real upload, live processing/final status and journal visibility.
Further response-budget/avatar-binding hardening requires its own final-head
regression/CI; this paragraph is not a claim that CI already passed that head.

**Still blocking Ready:** production-wide terminal/Custom Skill/browser
anti-bypass implementation and negative qualification, remaining provider
restriction diagnostics and exact-head cross-platform CI. Production publishing
therefore stays **fail-closed**, even with Pro, rather than silently trusting
an unproven channel boundary. Only explicit in-process fixture composition
activates local HTTP sending in tests; it is not a release/configuration option.
No terminal/browser product features were disabled to manufacture a Pass.
No real external account/post was used. PR #7 remains Draft and unmerged.


Final local hardened-tree validation: `npm run check` passed **2450 main tests /
228 platform skips**, **198 extension tests**, lint/docs/formatting, both
TypeScript checks and both builds. The new Chromium scenario was separately
typechecked with the repository's strict/index-safety settings. Cross-platform
CI and the entire Chromium regression must be read from their final-head run,
not inferred from these local Linux results. The production anti-bypass barrier
above remains unresolved regardless of green regression checks.

Final local Chromium regression on this implementation passed **60 tests / 3
explicit skips** (11 test files), including the new shipped publication-dialog
scenario and existing native-extension/service/browser acceptance workflows.
The publication E2E also verifies disclosure-category validation after DOM
tampering and rejects account/file substitution through the owner IPC bridge.
These checks do not qualify the outstanding production-wide anti-bypass barrier.

Windows qualification on `ea2786d` found an integration defect: snapshot startup
passed its directory to the native regular-file-only `protectFile` operation.
The correction uses `ensureDirectory` for directory creation and still requires
an explicit `ownerOnly === true` inspection before staging is opened. File
protection for snapshot/manifest writes is unchanged. A deterministic regression
uses a protector that rejects directories; false/unknown owner-only inspection
still refuses startup. This is not a relaxation of Windows ACL enforcement.
New-head native CI is required; the failed head is not an 11/11 Pass.

Local validation of the directory/file protection correction passed `npm run
check`: **2453 main tests / 228 platform skips**, **198 extension tests**, both
builds/typechecks and lint/docs/format. Full Chromium passed **60 tests / 3
explicit skips** using the documented headless Linux fixture configuration.
Two earlier invocations failed due to missing browser/headless fixture options;
they are not counted as passing evidence. Windows native acceptance still
requires the new remote commit's CI, not the Linux protector fixture.
