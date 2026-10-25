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
