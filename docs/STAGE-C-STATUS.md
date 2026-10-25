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
