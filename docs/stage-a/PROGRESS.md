# Functional Stage A — working branch

Scope: the owner's A/B/C directive, Stage A first. Domain: **crot.network**.
No B/C work or merge is authorized by this progress record.

## Current slice

- Shared runtime allow/ask/deny rules and Strict Mode in PermissionEngine;
  existing hard denials and mandatory approvals remain authoritative.
- Owner RPC validation, protected two-phase persistence and audit for policy
  changes, including fail-closed recovery of interrupted changes.
- Emergency brake: Core process/network/browser cancellation, service admission
  latch, product task cancellation, HTTP/Relay close, audit, header/tray wiring.
- Restart explicitly required after stop; owner diagnostics remain reachable.
- Named loopback tokens: protected hash-only registry, names, bounded TTL,
  files/terminal/browser scopes, last use, one-time display, rotation and revoke.
  Verified transport bindings narrow the existing PermissionEngine. Scoped
  command execution requires L1, never the owner's unconfined launcher.
- Token invalidation cancels pending/running tasks, closes HTTP sessions/requests
  and terminates matching background resources without Strict Mode approval.
- Fixed native Electron folder-picker action, canonical project registration and
  idle workspace switching. Real Electron/GTK cancellation and folder selection are
  now qualified on Linux, including Core switching, shipped UI refresh and audit.
  Concurrent pickers and false selection success are refused. See AD-49.

- Guarded OpenAI / Anthropic / OpenAI-compatible Local HTTP model inventory,
  streaming, bounded text/image attachments, cancellation and opt-in tool calls.
  Header and inline chat share the existing approval queue. Keys use the vault;
  provider fixtures do not qualify live vendor accounts. See AD-45.
- Digest-bound Allow once / Allow for project / Reject through the one existing
  approval broker. Exact workspace/operation grants persist in protected policy,
  survive restart, can be revoked separately, and never override Strict Mode,
  runtime deny, mandatory gates or hard capability/workspace ceilings. See AD-46.
- Owner project inspection reads fixed manifests through FileSystemService,
  reports bounded stack evidence, and observes actual Linux same-user/project-cwd
  TCP listeners through a separately guarded process operation. Cancellable tasks,
  audit and the idle workspace-switch barrier cover the whole workflow. See AD-47.
- Fixed a real Chromium scroll/OOPIF input race: prepare routing with a move,
  revalidate before pressing, require trusted activation for click delivery, and
  never replay a press. The real test asserts down/up/click in the target iframe,
  not only a broad pointer count. See AD-48.
- Project inspection survives a pending-response rerender and subsequent navigation
  without repeating a guarded Core operation. Workspace changes discard its bounded
  snapshot; only an explicit owner inspection refreshes it. See AD-50.

## Still required before Stage A acceptance

- **General application-secret protection is not implemented at the L1 process
  boundary on Linux/Windows. Do not rely on this branch to protect arbitrary project `.env`,
  `*.pem` or `*.key` files from child commands.** Existing CROT service-secret
  protection remains distinct. The macOS AD-52 native rule passed both actual
  macOS CI jobs at `cb71d2b`; its documented hardlink/host constraints remain.
  AD-53 adds owner IPC/UI access/revocation; current-slice qualification is separate.
- Native macOS/Windows folder-picker smoke passed actual CI at `7e217890`
  (AD-54); final-head native qualification is still required. The project-owned port observers
  (AD-51) passed the actual-OS matrix at `48420e9`. Darwin uses libproc identity and fixed
  lsof fields; Windows uses owner-PID TCP tables and bounded same-owner cwd reads.
  Linux parser tests do not qualify either native ABI. Results are point-in-time
  evidence, never proof that unlisted ports are free.
- Final complete-Stage-A native qualification and observed green remote CI for
  the final candidate SHA. Local checks and Chromium's test-only IPC bridge do
  not qualify macOS/Windows Electron dialogs, native L1 on other OSes or GitHub CI.

The real-service connect → task → owner approval → audit integration and shipped
Chromium chat → real CrotService → inline approval → actual write → audit journey
pass. The same UI also verifies project-persistent approval and a later action
without another request, and real manifest inspection. No live provider/Relay
account is claimed qualified by local fixtures. B/C remain unstarted. [PR #5](https://github.com/crotMcp/crot/pull/5) is open as
Draft solely for the existing cross-platform CI; it is not Stage A acceptance or
a request to merge. No PR was merged by the agent.

See [verification](VERIFICATION.md) for observed command results and explicit
qualification limits. This is not
an installable release or qualification of live providers/Relay.

### Project secret-file gate (AD-52, in progress)

- Previous published head `48420e9276c6ac00be405a2e1824d2dc695b31c9`:
  all eleven existing GitHub checks passed. PR #5 remains Draft; this is not
  complete Stage A acceptance.
- Added mandatory shared Core filename policy and exact workspace-bound owner
  configuration opt-ins. Native macOS dynamic filename rule and adversarial
  tests are a candidate pending actual macOS CI, not a Linux-qualified claim.
- Linux/Windows future-file L1 protection and live owner grant/revoke IPC/UI
  remain open. macOS host Docker binds are conservatively refused (AD-52).


### Owner secret-file controls (AD-53 candidate)

The previous head `cb71d2bd57aa79a356619df41e9300c7f316430d` completed all
11 GitHub checks successfully, including actual macOS late-secret kernel tests.
It is not complete Stage A acceptance. AD-53 adds protected transactional owner
state, exact-file grant/revoke controls, irreversible old-Core retirement and
real process drain before acknowledgement. First targeted Core/service tests
passed, including an actor holding an open secret descriptor. Full local and
remote qualification of this new source is still required. Linux/Windows
future-file L1 and actual macOS/Windows native folder dialogs remain open.
B/C are not started and PR #5 is not merged.

AD-53 local qualification now passes: main 2311 tests, extension 196, real
Chromium 58 (3 existing platform placeholders skipped), shipped UI QA 81 checks
and Linux native picker 3 checks. All 221 host-inapplicable main tests remain
explicitly skipped; local Linux does not qualify their native implementations.
Current-source GitHub CI must still be observed before claiming this slice
remotely qualified. Full Stage A remains incomplete for the gates above.


AD-53 head `8ca0cd7` now has observed **11/11 SUCCESS** remote checks,
including both actual Windows jobs and both macOS jobs. AD-54 next adds actual
native-folder chooser qualification to those existing matrix jobs. It remains
unqualified until those new tests run successfully. No workflow modifications,
security downgrades or agent merge are performed.

### AD-55 — authorized Windows native-secret candidate, not acceptance

The owner now permits reconsidering AD-29's third-party-filesystem exclusion
under zero-fee, proprietary-compatible licensing and Microsoft-signed-driver
constraints. The first isolated CI experiment combines pinned official Dokan
2.3.1 (dynamic LGPL DLL) with real zero-capability AppContainer/LPAC Jobs. It
requires live projected data read/write, unchanged original security, and raw
control denial before/after access with the same actors. It is not the rejected
WRITE_RESTRICTED Low actor and does not alter its old failed evidence.

Production is unchanged: no driver installation, dependency adoption or new
project-secret L1 availability claim. Missing-component fail-closed integration,
actual dynamic secret patterns/exact grants/revocation and final CrotService
qualification remain mandatory before the candidate can replace a backend.
Native Windows CI evidence is pending; Linux tests are not Windows proof.


AD-55 first actual Windows run (`94ede67`, Node 20/22) **FAILED** live-data
access while preserving raw-device denial; it is not a usable backend or Pass.
A bounded numeric diagnostic follow-up localizes open/read/write/flush refusal
and whether the request reached native callbacks, without widening permissions.
The unrelated macOS heartbeat wall-clock race is covered by paired controlled-
clock real-socket positive/negative tests. Missing-component production
fail-closed integration and the Linux/Windows future-secret barrier remain open.


The diagnostic follow-up `cc244740` completed **9/11** checks successfully.
Both macOS jobs now pass the heartbeat regression. Both actual Windows jobs
report identical data open error 5 with **zero create callbacks** for both
actors. It is not a filename callback defect. The next AD-55 experiment tests
an explicitly inherited, root-only data directory capability, preserving the
raw device ACL and every raw-denial gate. It is relative-NT feasibility only,
not general Win32 tool compatibility, activation or Stage A completion.

### AD-55 final scoped-directory observation / AD-56 licensing gate

The relative-capability head `da34dce8` also completed **9/11 SUCCESS**, with
both actual Windows jobs failing data open (error 5, zero create callbacks)
for AppContainer and LPAC. Its directory-handle workaround is rejected; no
backend is adopted. The source and CI merge have an identical Git tree; see
[exact-source evidence](../evidence/windows-l1-ad55/da34dce8-component-summary.json).
Local full check passed 2359 tests /223 host skips, extension 196. This is not
Windows acceptance. The previously successful native folder chooser remains
qualified at its recorded source; it is not an outstanding chooser experiment.

AD-56 records the licensing gate for alternative Pismo research: permissive
SDK does not grant redistribution rights for the separate runtime. No runtime
was executed/installed, bundled or adopted. Commercial integration rights,
Microsoft kernel signature and actual AppContainer/LPAC data/control isolation
are unqualified. Linux/Windows future-secret barriers and new-backend production
fail-closed integration remain open. Stage A is NOT Pass; PR #5 stays Draft,
no agent merge, B/C unstarted. Domain remains crot.network / mcp.crot.network.

### AD-57 — driver ban restored; native projection is not yet qualified

Removed active Dokan SDK/MSI provisioning and executable new helper implementations
(comment-only historical markers remain);
Pismo was never bundled/installed. The retired builder refuses explicitly,
and the mandatory native positive gate is NOT skipped/converted to an expected
failure. This change must not be reported as 11/11 qualification or Stage A Pass.

The owner's broader `.env*` mask is applied to shared Core policy and the
macOS Seatbelt compiler, with exact opt-in/non-prefix regression cases and
actual-macOS future-file tests extended to `.envrc`/`.ENVbackup`.

AD-57 records deterministic real-filesystem counterexamples: in-place hardlink
writes are direct, but atomic saves break identity, source rename-to-secret
retains a readable public alias, permissions are shared, and finite stubs do
not provide synchronous name creation enforcement. These are not simulated
AppContainer/L1 acceptance. No watcher is adopted as a security boundary.
A provable native guard or owner-approved restricted Windows execution contract
is still required before activation; Linux/Windows future-secret L1 remains open.


### AD-58 — owner-approved Core-only source contract

AD-58 supersedes the impossible AD-57 transparent writable hardlink contract.
CrotService requires native L1 for commands even in Full Control, gives children
empty private scratch, and protects the entire live source and Core context.
No source projection/import/copyback is performed. Project edits use checked Core
operations. Secret masks and multiple-link file aliases are refused before I/O;
exact authenticated owner grants apply only to Core, never arbitrary children.
Checked source mutations serialize against command admission, drain native actors
before ACL restoration, discard scratch and invalidate stale resolved commands.
Subsequent commands receive a fresh generation. Drain failures are fail-closed.
Browser downloads share that transaction; uploads reject secret/hardlink aliases.
Unchecked generic Git/Docker helpers are intentionally refused. No driver added.

Mandatory native tests now exercise the actual running child against existing,
future and reclassified source secrets, source reads/writes/atomic replacement,
Core control canaries, positive scratch writes, checked Core commits and fresh
generations on Linux, macOS and Windows AppContainer. This is NOT LPAC qualification.
The native gate emits a bounded record only after assertions and teardown succeed.

Pre-final source `f6fe41789c5378666a21fbd5535ef590186cbec9` passed local full
check: **2374 passed /226 host-inapplicable skips**, extension **196 passed**;
real Chromium **58 passed /3 explicit platform placeholders**. Its nine non-Windows
CI checks passed. An earlier Windows run exposed an incorrect error-code expectation
in a new negative browser-upload test: native Windows rejects hardlinks earlier
with `OPERATION_FAILED: Windows hardlink`, before a handle/bytes reach Core. The
correction requires this exact native refusal and empty staging, not an arbitrary
failure; positive checked downloads remain mandatory. The concurrency regression
separates source-write and positive-command phases because AD-58 intentionally
drains commands on mutation. Neither correction relaxes a native security gate.

Final exact-head qualification remains pending at publication of this entry;
no prior 9/11 result is Stage A Pass. PR #5 stays Draft until all eleven checks
and the new native gates pass. Final observed results are recorded in the PR
acceptance report. No merge; B/C unstarted; domain crot.network unchanged.
