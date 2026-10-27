# Stage D — release hardening and external build gates

Baseline: merged Stage C `a8a8e10ee5392e134d53bf219958318f2da4e8da`.
Implementation, verification, delivery and operations remain separate axes. PR #8 prepares repository materials; it does not deploy production, publish legal pages, sign installers, charge cards or post to real accounts.

## Runtime dependency remediation

Baseline `npm audit --omit=dev`: five affected runtime packages, three high and two moderate. The reviewed update uses supported dependency ranges and a committed lockfile, without `--force`, suppressed advisories, or overrides:

| Package | Baseline lock | Updated lock |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.31.0 | 1.32.2 |
| `zod` | 4.6.5 | 4.6.7 |
| `body-parser` | 2.3.0 | 2.4.0 |
| `fast-uri` | 3.1.8 | 3.1.9 (compatible 3.x, not a forced major) |
| `ip-address` | 10.7.3 | 10.7.5 |

Electron, although classified as a development dependency, is used for desktop runtime/QA: its same-major pin is also updated from 44.5.1 to 44.9.3 to remove the reported Electron high advisory. This does not provision/sign a production Electron runtime. Remaining development-toolchain advisories (including the Vitest/Vite worker stack) are not resolved by the runtime-audit criterion; changing Vitest major/Node support requires a separate review.

Direct SDK/Zod minimum ranges are raised; no strict validation schema, limit, negative assertion or permission check is relaxed. `npm run lint` first invokes `npm run audit:runtime` (`npm audit --omit=dev --audit-level=low`), so every existing CI OS/Node job and local `npm run check` requires zero runtime advisories, preserving the 11-job matrix. The connected GitHub token cannot modify workflow files; the existing CI lint step provides this mandatory gate without changing token permissions or branch protections. Registry/advisory state is time-dependent: rerun after a clean `npm ci` and record the exact commit/time. Development dependency findings are not a zero-all-dependencies claim.

## Extension store archive

Run `npm ci`, `npm run check`, real Chromium E2E, then `npm run package:extension` twice. Require identical ZIP bytes and SHA-256 sidecars. The archive includes exactly the reviewed compiled JS modules, static popup/welcome assets, `manifest.json` and four PNG icons (16/32/48/128). Source, tests, fixture hooks, maps, node_modules, icon-generation JSON and stale build modules do not enter the archive. Unexpected compiled modules fail packaging; remove stale output and rebuild rather than shipping it.

Manifest validation pins MV3, exact permissions/host permissions, incognito prohibition, reviewed service worker and popup, icon paths, and a CSP without remote/evaluated code. No externally-connectable API, web-accessible resources, content scripts or custom update URL is accepted. Permissions remain broad for the actual tool purpose, not minimized by disabling security guards. Archive inspection and real Chromium tests do not replace Chrome/Edge store approval or a signed official extension-ID catalog.

## Desktop packaging verification

`npm run build:release -- --environment /trusted/public-identity.json` emits a pinned compiled payload, native source inventory, notices, SBOM and checksums. `npm run package:desktop` packages the current host as `crot-linux.tar.gz`, `crot-macos.tar.gz` or `crot-windows.zip`, with SHA-256, tracked native/build sources, dependency lock, legal drafts, installation guidance and an explicit prerequisite notice. Output paths are checked against source/state overlap and symlinks before cleanup.

These are **operator-managed source/compiled bundles, not autonomous MSI/DMG/DEB installers**. They do not include a complete provisioned Node/Electron/npm/native runtime, vendor signatures or a qualified installation flow. Windows x64 additionally builds the local shim with the Windows SDK; other Windows architectures remain unqualified. macOS/Linux tar commands run on their native hosts. Do not infer three-OS installability from a Linux bundle smoke. Existing native CI qualifies its explicit OS/architecture scopes, not every customer system. Signing and packaging each actual runtime/native binary remains external.

## Exact external configuration/key checklist

- [ ] **Pinned identity:** `RELEASE_IDENTITY_ENVIRONMENT` (or `build:release --environment`) is a reviewed **public JSON file path**, with production issuer, `relayHost: mcp.crot.network`, actual public `pairingClientId`, loopback redirect port and scopes. `deploy/production/identity.example.json` contains a placeholder client ID; never ship it unchanged. No secret goes in release metadata. Development `CROT_IDENTITY_DEV_ENVIRONMENT` is not a production override.
- [ ] **Release checks/signature:** `CROT_E2E_CHROME` identifies a qualified browser; `CROT_UPDATE_SIGNING_KEY` points to an externally protected **Ed25519 private key** for `build:rc`. Trust its public key out of band. Production RC refuses `--skip-check`/`--skip-e2e`; `--repository-test` is visibly non-releasable. Vendor code signing is a different key/process.
- [ ] **Hosted identity/Relay:** configure actual issuer, public portal/pairing client allowlists, exact redirect URIs, `portalClientIds`, and protected `workosSecretFile` for supported session revocation. Provision `tls.certFile`, `tls.keyFile`, `metricsTokenFile`, private state volume and DNS/TLS for the official domains. Verify proxy logs exclude payloads/headers/codes. Use the single-writer storage contract; do not share JSON state across relay writers.
- [ ] **Stripe — server-only:** `billing.secretKeyFile` holds the live secret API key; `billing.webhookSecretFile` holds the matching endpoint signing secret. Configure distinct `billing.prices.pro`, `proAnnual`, `proFounderAnnual` (and the legacy `team` compatibility mapping where needed), and approved `billing.returnUrl`. Verify active USD 500/month, 3900/year, 2900/year amounts, intervals, taxes, merchant identity, seven-day card-backed monthly trial and cancellation/refund notices. Configure signed subscription created/updated/deleted events at `/billing/stripe`; test current-state reconciliation. No Stripe secret is an environment value compiled into a desktop/extension artifact.
- [ ] **OAuth providers:** register reviewed exact callbacks/scopes, platform approvals and the Notion broker callback `https://mcp.crot.network/oauth/notion/callback`; configure its actual operator-owned confidential application secret file on Relay. User account tokens remain in local OS stores; registration/live-provider qualification is separate from fixtures.
- [ ] **Windows:** provision SDK/compiler and qualified native components; obtain an operator-owned Authenticode certificate/private key (or hardware signing access), timestamping and installer tooling; sign the real executable/DLL/installer inventory and verify signatures on an installed clean Windows x64 system. The current bundler does not consume a PFX variable or create/sign an MSI automatically.
- [ ] **macOS:** provision qualified native/runtime dependencies; supply Developer ID Application/Installer identities, hardened runtime/entitlements and authorized notarization credentials (App Store Connect key or approved profile) to the **external** signing pipeline; notarize, staple and test the installed artifact. No automatic DMG/PKG signing is claimed by this repository script.
- [ ] **Linux:** provision qualified bubblewrap/AppArmor/L1 and runtime dependencies on each target distro/architecture; create actual DEB/RPM/repository metadata if distributed that way and protect its signing key externally. A tarball checksum is not a signed distro package or installation smoke.
- [ ] **Legal/store/operations:** complete [legal register](legal/README.md), publish EN/RU HTTPS pages, reconcile live Settings/store links, approve extension store declarations and IDs, verify installed update/rollback/uninstall, live backup/revocation/DR and final go/no-go. No secrets, real posts, payments or user-account revocations are used for repository acceptance.

## Evidence record

Record PR head SHA, clean lockfile install, runtime audit counts, full check counts/skips, Chromium suite counts/skips, extension ZIP entries/digest/reproducibility, desktop bundle scope/digest, signed RC test scope and all 11 final-head CI jobs in the PR. A predecessor's green CI never qualifies a new SHA. Operator placeholders in legal/build examples must not be treated as completed deployment.
