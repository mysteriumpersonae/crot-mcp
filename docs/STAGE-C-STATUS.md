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

#### AD-67 anti-bypass and diagnostics checkpoint (qualification pending)

Implemented independent Core/extension protected-route refusal, pending URL and
real frame-inventory checks, sensitive session listing exclusion and social-SPA
input refusal, plus generic Core HTTP refusal on protected GET endpoints. Added
deterministic Core/extension tests and an actual native-extension Chromium open
refusal case. Reserved service/session env names are denied in both terminal and
Custom Skill scratch launch admission with audit. OAuth scope metadata records
actual recognized grants; missing scope, HTTP API restrictions/rate limits and
YouTube channel/quota errors have fixed safe diagnostics in the account card,
review dialog and exported system check.

**Not closed:** arbitrary command network-on egress, renamed/native secret-store
API qualification, and positive evidence of X paid write-tier / remaining YouTube
upload quota. Unknown platform facts are shown as unknown, not fabricated. CLI
name filters would not solve this. Production publishing remains fail-closed;
PR #7 stays Draft and unmerged until native mediation and acceptance are complete.
Prior 11/11 applies to `397c442`, not these unqualified changes.

Local AD-67 regression passed **2497 main tests / 228 platform skips**, **203
extension tests**, lint/docs/format, both builds/typechecks. Full real Chromium
passed **61 tests / 3 explicit skips** across 11 files, including independent
MCP/Core and actual native-extension protected-open refusals without contacting
external platforms. The E2E file passed a separate strict/index-safe TypeScript
check. Generic process environment tests now use non-service variable names;
reserved-name refusal has separate audited terminal and scratch-skill coverage.
Earlier failed runs exposed necessary packaging permission and queue-metadata
expectation updates and are not counted as passing evidence. New-head CI is
still required. These results do not qualify arbitrary command egress or close
Stage C's production activation barrier.


CI `793c988` completed 9/11; both Windows jobs correctly refused an old generic
process test's explicit `CROT_TEST_LITERAL` override under AD-67. That fixture
now uses `NATIVE_TEST_LITERAL`; its PATH/private-temp/SystemRoot assertions and
actual native process launch remain unchanged. The mandatory reserved-name
guard is not relaxed. Other `CROT_*` secret-inheritance canaries are retained.
A new-head native Windows run is required, not a blind retry of the failed head.

Windows fixture correction `6abb5d8` qualified on Node 20 and Node 22. Its
exact-head CI completed 10/11: Node 20 Windows instead exposed the remote
deadline fixture's one-second pre-approval admission budget. The 6000ms test
relay deadline minus the unchanged production 5000ms margin could expire before
the real TLS/ACL/owner event reached the approval queue, so it did not exercise
the pending-write path it claimed. The fixture now uses a 12000ms relay budget,
explicitly requires owner approval delivery within 5000ms, and checks device
cancellation near 7000ms (strict 6500–9500ms bounds), absence of the write,
stream drain and deadline audit. Production timeout/margin and security guards
are unchanged. This needs its own local and exact-head CI qualification; it is
not a retry of the failed head or a declaration of Stage C completion.

#### AD-61 credential/control clarification — qualification in progress

The owner explicitly accepted credential/control-plane isolation, rather than
DPI of raw network-on sockets. Added mandatory native OS-canary and live owner
channel negative probes for terminal and the same execInScratch path used by
Custom Skills. Windows calls actual CredReadW from an SDK-built child; macOS
uses an existing temporary Keychain item; Linux uses a private real D-Bus /
gnome-keyring Secret Service and gives the malicious child the true bus address.
Every platform requires successful owner reads before and after denial, an
actual owner ping and successfully executed child probes. A separate real
service integration rejects service credentials at owner RPC and MCP confirm
attempts even with a real owner permit. Production remains blocked pending
this qualification; no native pass or Stage C completion is yet claimed.

Native qualification `3d4130e`: macOS Node 20/22 passed the new canary/control
tests; Linux L1 setup failed (workflow dependency write denied); Windows exposed
a shutdown ordering defect: product-vault atomic replacement preceded native
lease release. Core now has host-only quiescence (closed admission, actor drain,
confinement release, audit retained); service uses it before final product vault
persistence, then closes audit normally. A portable regression verifies admission
and audit ordering; the unchanged native test still requires complete teardown.
No sharing/DACL guard or retry limit is relaxed. Linux missing dependencies now
produce explicit executable diagnostics instead of a generic setup timeout.
An independent Node 22 Linux process test timed out in CI; the unchanged focused
local process suite passed 29 tests / 11 skips. It is not claimed resolved.
Production remains blocked pending native and final-head qualification.

After workflow authorization, the Linux dependency change was pushed on
`51f3b7a`. Full authenticated Windows logs showed `e655916` now closes cleanly,
but the foreground task's own final persist still conflicted with fixed private
controller-file identity pins. The corrected native policy retains verified
owner-only/Medium No-Read-Up protection for those exact controller files, checks
single-link regular identity and descriptors before launch, and keeps all other
protected/source/credential identity guards unchanged. Native acceptance now
also holds the same actor across a real atomic vault replacement. This is
qualification work, not a claim of native pass or production activation.

Windows native follow-up: `f11d0b5` retained 9/11 checks but its new probe had
incorrectly assumed automatic source import. The SDK executable is now staged
through command stdin into empty AD-58 scratch, never linked from source.
That exposed a real service-composition defect: scratch inherited Medium/NR
from the service's private parent and denied even a normal write. The native
backend now creates only a NEW disposable scratch leaf with verified Low/NW
owner-only policy. It refuses existing objects; private ancestors, source,
controller credentials and vault keep their original protections. The portable
composition test verifies this hook is used before native open. The real OS
credential/control negative assertions remain mandatory and unchanged. These
are fixes pending CI evidence, not production activation or completion claims.


#### AD-61 native qualification complete on predecessor; final activation gate

The full CI for `693a55715000513d0fa16d5bb911fc75db419403` completed **11/11
successfully**: Ubuntu/macOS/Windows Node 20/22, all four Linux L1 matrices,
and real Chromium. Both Windows jobs completed their full suites, not only the
early mandatory credential/control step. Evidence:
[main CI](https://github.com/crotMcp/crot/actions/runs/40315533860),
[Linux L1](https://github.com/crotMcp/crot/actions/runs/40315533955),
[Chromium](https://github.com/crotMcp/crot/actions/runs/40315533857).

Only after observing that evidence, the unconditional production refusal is
replaced with fresh verified active Pro/trial/legacy Team and qualified host-native
AD-58 readiness. Missing core-only source access, unknown/wrong-host mechanism,
unavailable native L1, non-null failure reason, thrown refresh, halt or Core
replacement refuses publication; no stale-positive/unconfined fallback exists.
The gate runs on preparation and again before delivery. Informational scratch
status detail does not count as a failure. Snapshot, recipient/account generation,
explicit privacy/consent, one-use owner connection permit and audit are unchanged.

`system.check` now reports native credential/control readiness, owner-enabled raw
network-on without DPI, native network-off blocking, and the remaining Pro,
owner-confirmation and immutable-snapshot requirements. A refresh exception is
reported unavailable even if the previous cached status was successful.
Regressions cover commercial/native admission and refusal, repeated refresh,
errors and mid-await halt/entitlement/Core changes, actual production service
wiring (host status doubles only), and the real product diagnostic RPC handler.
All delivery tests use local HTTP fixtures; the production-wiring test revokes
readiness before confirm so no production-provider send is authorized.

Earlier open-barrier checkpoints above are historical, superseded by this gate
implementation and the owner-approved AD-61 contract; they are not deleted.
Final local checks and new-head 11/11 remain required before Ready/merge. The
predecessor's green CI does not qualify this change. No public release, live
Stripe/provider acceptance, signing or installer completion is claimed.
