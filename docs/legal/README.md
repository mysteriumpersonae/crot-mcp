# CROT legal publication register — EN / RU

**Status: substantive pre-release drafts, NOT active contracts and NOT a legal opinion.**
The repository establishes technical behavior, not the operator's identity, applicable law or tax status. No public legal page, merchant account or regulator approval is claimed. Complete the gates below with qualified counsel before publishing or enabling sales. This work does not deploy a website.

## Website source map

| Intended URL | English source | Russian source |
| --- | --- | --- |
| `https://crot.network/terms` | [Terms of Service](TERMS_OF_SERVICE.md) | [Условия использования](TERMS_OF_SERVICE.ru.md) |
| `https://crot.network/privacy` | [Privacy Policy](PRIVACY_POLICY.md) | [Политика конфиденциальности](PRIVACY_POLICY.ru.md) |
| `https://crot.network/subscription` | [Subscription Terms](SUBSCRIPTION_TERMS.md) | [Условия подписки](SUBSCRIPTION_TERMS.ru.md) |
| `https://crot.network/docs` | [User guide](https://github.com/crotMcp/crot/blob/main/docs/USER_GUIDE.md) | Translation and live hosting remain operator work |

Language selection must be explicit; keep both versions and their effective dates synchronized. These are proposed publication routes, not assertions that existing Settings buttons or live pages resolve to them. The current Settings/About implementation does not contain Terms/Privacy website links; wiring verified live URLs is a separate deployment/UI task, not an excuse to open arbitrary renderer URLs. Do not advertise an unpublished policy as effective. DPA and vulnerability-disclosure drafts retain their independent approval gates.

## Mandatory operator/counsel register

- [ ] Replace every bracketed field in each publication document: legal name, registered address, registration/tax information, effective date, jurisdiction, age/capacity rule, privacy/support/billing/security contacts, complaint route and version archive.
- [ ] Decide consumer/B2B scope and markets; review governing law, liability cap, refunds, withdrawal, renewal notices, taxes and language requirements. Do not infer operator residence or legal entity from a GitHub/Notion account.
- [ ] Name actual WorkOS, Stripe, hosting/CDN/DNS, support and monitoring entities, regions and transfer safeguards. Verify contracts/DPA and international-transfer assessment where required.
- [ ] Fill retention/deletion and backup expiry schedules; verify proxy/CDN/APM logs do not retain bearer headers, OAuth codes, payloads or sensitive query strings. Code-level no-persistence is not proof of deployment settings.
- [ ] Confirm cookie/session inventories, website analytics choices, rights handling, incident response and regulator contacts. No unimplemented cookie-consent or deletion UI is promised.
- [ ] Reconcile checkout text, Free/Pro pricing, seven-day card-backed monthly trial, renewal/cancellation and founder offer with the active Stripe products. Legacy Team compatibility is not a new advertised plan.
- [ ] Publish accessible HTTPS pages, language switch, archived versions and store privacy URL; test them from the signed installed app and store listing. Never commit keys or live credentials.

## Technical source-of-truth and limitations

[AD-58/AD-61](https://github.com/crotMcp/crot/blob/main/ARCHITECTURE.md), [relay](https://github.com/crotMcp/crot/blob/main/docs/RELAY.md), [accounts](https://github.com/crotMcp/crot/blob/main/docs/ACCOUNTS.md), [native host](https://github.com/crotMcp/crot/blob/main/docs/NATIVE_HOST.md), [store disclosure](https://github.com/crotMcp/crot/blob/main/docs/store/PRIVACY.md), `src/service/social/account-secrets.ts`, `src/service/publications/authorization.ts` and `src/account-service/catalog.ts` ground these drafts. Local OS account-token stores are distinct from the encrypted local product vault and server-held operator credentials. Relay transit is TLS-protected hop by hop, not a claim of cryptographic end-to-end blindness. Temporary broker token processing is not durable token storage.

## Legal drafting references (verify applicability with counsel)

- [GDPR, including Articles 5, 6, 12–22, 28, 32–34 and 44–49](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng): information duties, lawful bases, rights, security and transfers where applicable; not a claim of certification or universal applicability.
- [EU consumer information and withdrawal framework](https://eur-lex.europa.eu/EN/legal-content/summary/consumer-information-right-of-withdrawal-and-other-consumer-rights.html): mandatory rights cannot be waived by a generic “no refunds” line or by treating a trial as the withdrawal period.
- [Chrome Web Store privacy](https://developer.chrome.com/docs/webstore/program-policies/privacy), [disclosure](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements) and [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/): truthful disclosure, limited purpose and affirmative consent where required. A repository draft does not satisfy the live URL/store declaration gate.
