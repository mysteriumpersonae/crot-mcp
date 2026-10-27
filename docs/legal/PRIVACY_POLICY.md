# CROT Privacy Policy — English

> **Pre-release draft — not yet an effective notice.** Complete the operator, processors, retention, lawful bases and transfer register in [the publication register](README.md), verify deployed infrastructure and obtain qualified legal review before publication. The policy describes intended processing supported by the repository, not a claim that production has been deployed or audited.

**Effective date/version:** [EFFECTIVE_DATE_AND_VERSION]

**Controller:** [OPERATOR_LEGAL_NAME_AND_REGISTERED_ADDRESS]

**Privacy contact / representative / DPO, where required:** [PRIVACY_CONTACT_AND_REPRESENTATIVES]

## 1. Scope and roles

This notice covers CROT's local bridge/browser extension and optional operator-run account, billing and Cloud Relay services at `crot.network` / `mcp.crot.network`. A user/organization deciding what files, agents and services to connect controls those operations. Where an organization appoints CROT as a processor, a separately completed DPA governs that role; CROT remains responsible for its own account/billing/security processing as applicable. Your chosen MCP clients, AI providers, publishing platforms, WorkOS, Stripe and browser stores have their own notices. We do not assert their processing is covered by CROT's no-storage promise.

## 2. Data processed and where it goes

| Category | Processing and location | Purpose / recipients |
| --- | --- | --- |
| Local workspace and browser data | Checked file reads/writes, page text/structure, tab/frame URLs and titles, screenshots, approved input/dialogs and download metadata on your device | Requested tools; results reach the initiating local or remote MCP client you chose |
| Local security and product state | Permissions, project registrations, local audit, task status, encrypted product vault and temporary/staged artifacts on your device | Authorization, continuity, diagnostics and reviewed publication |
| Connected-account OAuth secrets | Access/refresh tokens and account application secrets in macOS Keychain, Windows Credential Manager or Linux Secret Service; OS-only account-store admission | Provider authentication; never an agent-visible token export |
| Optional cloud identity | Verified subject/account ID, session/client identifiers needed for authentication and revocation | Account access, management and security; configured identity provider |
| Device and subscription metadata | Random device IDs, public keys, registration/revocation state, bounded client last-seen/session IDs, plan/status/expiry, Stripe customer/subscription/event IDs | Route authorized traffic, enforce entitlement and quotas, reconcile billing and revoke access |
| Payment information | Card entry at hosted Stripe Checkout, not a CROT card form | Stripe/payment providers; CROT receives billing references/status, not full payment-card details |
| Operational/support data | IP/connection information transiently required for transport/rate limiting; fixed-code logs, timestamps, counts, versions; information you intentionally submit to support | Security, availability, abuse prevention and support; exact deployed log fields/retention require operator disclosure |

Local use requires no CROT account and does not enable device telemetry by default. CROT has no advertising or analytics SDK in the extension. Optional website cookies/session storage and any deployment-added analytics must be inventoried and disclosed at [COOKIE_AND_WEBSITE_NOTICE]; nonessential tracking requires the applicable consent mechanism before use. This draft does not imply that such tracking or a consent UI exists.

## 3. No durable server storage of user secrets — exact boundary

CROT does not intentionally persist user-connected-account OAuth access/refresh tokens, user API keys, local vault contents or MCP request/response bodies on CROT servers. Connected-account tokens use the device's supported OS credential store. Other user-configured connector/chat credentials can reside in the encrypted **local product vault**; it would be inaccurate to say every local secret is always in Keychain. Generic local service secrets have their documented backend; connected-account OAuth has no silent plaintext fallback. Owner-private account metadata is separate from tokens.

Relay forwards user-requested MCP traffic and must handle bytes in memory while routing. TLS protects the client-to-relay and relay-to-device connections; this is **not** a claim of end-to-end cryptographic blindness to the Relay. A remote request/result may contain content or secrets you deliberately include. It is transmitted to the selected client/provider as requested, not archived as a CROT payload history. No-storage is not no-processing or a guarantee that a recipient will not retain data.

The optional Notion OAuth broker uses a temporary native PKCE leg and a separate upstream confidential exchange. Authorization codes/state and returned token fields are processed temporarily in memory to complete, refresh or revoke the requested grant; user access/refresh tokens are not durably stored by the broker. Operator-owned WorkOS/Stripe/Notion application secrets, TLS keys and signing credentials are separate server infrastructure secrets, not user-connected-account tokens. They must be protected, not falsely described as nonexistent. Auth bearer tokens are processed to verify/route requests, not retained as log records.

Production reverse proxies, CDNs, error trackers and backups must be configured consistently: no request-body capture, authorization headers, OAuth code/query logging or secret-bearing crash dumps. That deployment check is a release gate; repository behavior alone cannot certify it.

## 4. Local isolation, network and publication

AD-58 gives arbitrary commands empty private scratch rather than direct project access; no automatic source import or copy-back occurs. Checked Core operations and explicit artifact export remain separately authorized. AD-61 isolates connected credentials and the owner control plane. Explicit owner-enabled raw `network=on` is not DPI/TLS filtering; arbitrary programs and independently supplied credentials remain the owner's risk. `network=off` uses native blocking. No host-security boundary survives an independently compromised privileged host.

The extension's `nativeMessaging`, `tabs`, `scripting`, `alarms`, `debugger`, `tabGroups`, `downloads`, `webNavigation` and `<all_urls>` permissions support only authorized local browser tools. Frame URLs enforce mandatory OAuth/publication guards; they are not a cookie/credential export API. Incognito is disabled; no externally-connectable API, remote executable code or persistent browsing-history archive is supplied. Optional remote tool responses may traverse Relay to the initiating client; “no extension telemetry” does not mean “results never leave the device.” We limit browser-data use to the disclosed tool purpose, not advertising, credit scoring, resale or unrelated profiling.

Publication requires fresh verified commercial entitlement, native readiness and explicit single-use human owner confirmation of the account, privacy/consents and immutable SHA-256 media snapshot. Only then are relevant content and credentials sent to the selected fixed provider endpoints. The provider controls subsequent hosting, public visibility and deletion; canceling CROT cannot guarantee recall of accepted content.

## 5. Purposes and lawful bases

Where GDPR or similar rules apply, necessary account/Relay/subscription processing is for providing the requested contract; billing records may be needed for legal obligations; proportionate security, abuse prevention and essential service reliability may rely on legitimate interests with an applicable balancing assessment; optional communications/nonessential tracking require consent where required. The operator must confirm the exact bases and legitimate interests for its markets before adoption. Consent withdrawal does not invalidate prior lawful processing. We do not sell MCP content or use it for advertising/model training, and do not make legally significant decisions solely by automated profiling. Automated security/entitlement refusals can be raised with [PRIVACY_OR_SUPPORT_CONTACT] for review.

## 6. Sharing, processors and transfers

Data is disclosed only to requested MCP/model/publishing destinations, contracted identity/payment/infrastructure/support processors as needed, legally authorized recipients where required, or a successor with appropriate safeguards and notice. CROT does not choose an agent's downstream retention policy for you. Before publication, complete and make accessible [SUBPROCESSOR_REGISTER_URL] listing each actual legal entity, purpose, data categories, region and safeguard. Required categories include WorkOS, Stripe, hosting/TLS proxy/DNS/CDN, support and any monitoring service actually enabled; browser stores act under their own roles. Do not invent providers that are not deployed.

International transfers, where applicable, require a valid mechanism such as an adequacy decision or appropriate contractual safeguards and assessment; specify [TRANSFER_COUNTRIES_MECHANISMS_AND_COPY_REQUEST_ROUTE]. No region-only storage or regulator approval is claimed without evidence.

## 7. Retention and deletion

MCP payloads and user account tokens have no durable CROT server retention period because they are not intentionally persisted there. Temporary routing/OAuth buffers last only for the active exchange or bounded flow lifetime. Other categories require the operator's completed schedule:

| Category | Publication value to complete |
| --- | --- |
| Cloud account/device/subscription and security/revocation records | [ACCOUNT_SECURITY_RETENTION_AND_DELETION_TRIGGER] |
| Legally required invoice/tax records | [BILLING_RETENTION_AND_LEGAL_BASIS] |
| Infrastructure logs/rate-limit state and support records | [LOG_RATE_LIMIT_SUPPORT_RETENTION] |
| Backups and deletion propagation | [BACKUP_EXPIRY_AND_RESTORE_DELETION_PROCESS] |

Local audit, vault, metadata and publication snapshots remain on your device under their bounded storage/cleanup behavior until removed through supported operations or deliberate local cleanup. Do not assume uninstalling deletes them, revokes a platform grant, cancels a subscription or erases cloud records. Account disconnect invalidates local credential use, attempts provider revocation and local deletion, and reports failures; it is not proof that third-party copies disappeared. Retention may be restricted rather than deleted for legal/security obligations, with purpose and access limitation.

## 8. Security and incidents

Controls include TLS, verified signed identity/entitlements, owner-restricted state, supported OS credential stores, encrypted local product vault, native command isolation, Core permissions/approvals/audit and signed-update verification. Availability depends on qualified native prerequisites; missing protection fails closed. No system is perfectly secure. Report suspected exposure to [SECURITY_CONTACT]; never include secrets in public issues. Incidents are assessed and notified to authorities/affected people when and within the periods applicable law requires, without promising an unimplemented response SLA. Review diagnostic exports before sharing: local paths, operation metadata and material you supplied may be present.

## 9. Rights, choices and complaints

Depending on applicable law, you may request access, correction, erasure, restriction, portability, objection, consent withdrawal and information about transfers/recipients through [PRIVACY_CONTACT_AND_REQUEST_PROCESS]. We verify requests proportionately; do not send full credentials or unnecessary identity documents. Responses follow applicable legal deadlines, ordinarily one month under GDPR subject to its lawful extensions. Exceptions, legal retention and rights of others may limit a request with an explanation and complaint route. You may complain to [COMPETENT_SUPERVISORY_AUTHORITY_AND_CONTACT], or your competent local authority; contacting CROT first is not mandatory. Local-only content outside CROT's custody cannot be retrieved remotely by a privacy request; third-party deletion may require a separate request to that provider.

## 10. Children and changes

CROT is offered only subject to [MARKETS_AND_MINIMUM_AGE] and valid legal capacity/representative authorization where applicable. It is not intentionally directed to children below the applicable threshold; report suspected unauthorized child data to the privacy contact. Material policy changes will be notified through [NOTICE_CHANNEL_AND_ADVANCE_PERIOD], with a new effective date and archive at [VERSION_ARCHIVE_URL]. New purposes or consent-dependent processing require the additional notice/consent mandated by law. EN/RU copies must be synchronized; neither removes mandatory local rights.
