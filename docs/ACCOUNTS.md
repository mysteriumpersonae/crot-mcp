# Accounts, billing and cloud device management (WP-36 / AD-34)

Local / Free is permanently free, offline and accountless. Billing never reaches
Core, ExecutionGuard or PermissionEngine. Only cloud admission is commercial.

## Plans

| Plan | Remote | Registered devices | Lifetime |
| --- | --- | --- | --- |
| free | no | 0 | unlimited local use |
| trial | yes | 2 | 14 days, once per account |
| pro | yes | 5 | active paid period |
| team | yes | 20 | active paid period; v1 identity remains one account per user |

Only `active` and unexpired subscriptions admit remote traffic. `past_due`,
`canceled` and `expired` fail closed. Webhook cancellation is effective
immediately; a cancel-at-period-end subscription stays active until its paid
period ends. Expiry is checked on every admission and by a 250ms tunnel watcher;
no webhook is needed for wall-clock expiry. Subscription updates terminate
ineligible tunnels with **4403 / not_entitled**. Over-limit downgrades keep the
earliest registered devices (device id breaks timestamp ties); other registered
devices cannot open tunnels until eligible again. No registration is silently
removed on a plan downgrade. New registrations receive **403** with
`entitlement_required` or `device_limit_reached`.

## Deployment

The existing relay binary co-hosts AccountService. Its atomic owner-only state
file is `<registryFile>.accounts`. **The old WP-29 registry file is not imported
or licensed automatically.** Back it up; existing devices must be paired again
after their owner starts a trial or pays. Startup fails closed if the new state
file is malformed/unreadable. Back up this file with the relay stopped; loss of
trial/revocation state is a security incident, not an invitation to reset it.
There is one writer / one relay instance. `CommercialService` is the interface
for a future transactional shared store; do not share this JSON file between
processes. Data residency is the owner's chosen host and backup location, not a
claimed jurisdiction or production qualification.

Optional billing configuration in relay JSON:

```json
{
  "commercial": {
    "prices": { "pro": "price_OWNER_PRO", "team": "price_OWNER_TEAM" },
    "returnUrl": "https://crot.network/portal"
  },
  "minimumDeviceVersion": "0.1.0"
}
```

These fields augment the existing relay configuration; this fragment alone is
not a complete config. Prices must be two distinct Stripe recurring price ids.
Set **server-only** `CROT_STRIPE_WEBHOOK_SECRET`, `CROT_STRIPE_API_KEY` (hosted
checkout), and `CROT_WORKOS_API_KEY` (best-effort provider revocation). The compose
file forwards these variables; use owner-only deployment secret files. Never
put these values in a device config, a release identity artifact or Git.
Without billing configuration the trial/API still work; without a WorkOS key
provider revocation explicitly reports `not_available`. Configuring billing
without its webhook secret prevents startup. Stripe/WorkOS are not dependencies
of Core or a local installation.

Stripe endpoint: **POST `/.crot/billing/stripe`**. Enable subscription
created/updated/deleted events. The adapter verifies HMAC-SHA256 over raw bytes,
accepts rotated `v1` signatures with one timestamp, requires ±300s freshness,
bounds bodies at 256KiB and maps only owner-configured price ids. Stripe checkout
sets subscription `metadata.accountId` on the server from the authenticated sub.
Do not expose metadata editing to payment customers. Only these allowlisted
fields reach the state store; payment bodies, card data and customer profile
information do not. The service deduplicates event ids and refuses older
subscription state; equal timestamps may only narrow admission. Equal-second
ambiguous activation is conservatively refused until a newer provider update;
operators should reconcile with the provider, never edit entitlement JSON.
Subscription ids cannot move between accounts. A canceled/expired subscription
can be replaced with a newer subscription; late events from retired subscriptions
cannot reactivate it. Live billing setup and financial/legal policies remain
owner release gates (WP-37/WP-39).

## Account portal API

Use HTTPS and a WorkOS-issued first-party access token whose **aud** is exactly
`https://<relayHost>/.crot/account`, **sub** is the owner, and **client_id** is the
configured first-party pairing client. The owner must configure this separate
account resource in WorkOS in addition to the existing `/d/*/mcp` resource; no
default audience, no wildcard account-administration token. The provider's
hosted AuthKit signup/login obtains this token using its approved first-party
OAuth/PKCE registration. Ordinary MCP/device-audience tokens and other client
registrations are refused. No cookies, cross-origin CORS allowance or bearer in
URLs; use `Authorization: Bearer …`. No account id in request bodies is trusted.

| Path | Method | Result |
| --- | --- | --- |
| `/.crot/account` | GET | plan, status, entitled, remoteEnabled, maxDevices, deviceCount, expiresAt; devices with registration time/online state; client ids |
| `/.crot/account/trial` | POST | start one 14-day trial; 403 trial_used if previously used |
| `/.crot/account/checkout` | POST | `{"plan":"pro"}` or `{"plan":"team"}` → hosted Stripe Checkout URL |
| `/.crot/account/devices/<deviceId>` | DELETE | durable lost-device revocation, then best-effort provider revocations |

This is an API-first account portal; no password/card collection or embedded
payment form is hosted by CROT. Integrate it with the first-party hosted login
and Stripe Checkout. It is not a claim that a public production portal/DNS or
live merchant account has been deployed.

Lost-device revocation removes the public key/registration and leaves a durable
tombstone. All tunnels close **4403 / device_revoked**, PRM becomes **404**, MCP
returns **404 / not_executed**, and the old key/id cannot register again. The
owner can pair a fresh device/key. Foreign-account device deletion returns 404.

## Device / tray integration

POST `/d/<id>/account/challenge` with `{"action":"status","clientId":""}`
returns a random 30-second challenge. POST `/d/<id>/account` with the same action,
client id, challenge and device signature returns the plan/limits. For provider
revocation the action is `revoke_client` and the client id must have been seen
with a verified token for this device/account. Proofs are single-use and bind
device, relay host, action and client id in the `crot-commercial-v1` domain;
removal and tunnel proofs are not interchangeable. Source rates, concurrent
challenges, bodies and timeouts are bounded. Neither public device ids nor
unsigned JSON authorize these actions.

The service requests status only for owner overview/tray requests (30s cache),
not as telemetry. The UI displays plan, entitlement, deviceCount/maxDevices and
check time; offline/unavailable is explicit, never treated as a valid license.
It does not gate local tools. Client revocation is persisted and applied on the
device first. The cloud then calls WorkOS **DELETE
`/user_management/users/<sub>/authorized_applications/<client_id>`**, not deletion
of the shared Connect application. The provider API accepts application id or
client id. Authorization deletion is account-wide and may affect the same
client on other devices. Failure/offline is reported, not hidden or retried with
provider secrets on the device. Issued JWTs retain the AD-21 expiry bound;
revocation on the local device is immediate regardless of cloud availability.

## Privacy, diagnostics and compatibility

AccountService receives only typed account/subscription/device/client metadata,
never an IncomingMessage for MCP, paths, tab URLs, bodies or auth headers. Relay
and account operational logging excludes those data; unknown log fields are
dropped, method/software fields are allowlisted. No hidden device telemetry or
crash upload exists. Diagnostic export is an explicit local owner action, never
a background upload.

Tunnel published majors have a minimum 12-month support window. The window starts at the actual publication of a major; no production
publication is claimed by repository tests. The current v1 is retained at least
through October 2027, and longer if required by its publication date and release
notices. Unsupported majors and configured minimum-device-software
admission failures close 4426 / update required. The software string is only an
update hint, never trusted identity or authorization. MCP clientInfo/header
versions are not authenticated and are not an authorization policy. Bridge hello
major mismatch reports update_required through crot_status and update required
in the extension; the service/local filesystem continues running. A compatible
reconnect clears the mismatch. Tray/service use their existing local versioned
control protocol. Never silently change a supported tunnel major in place.

## Automated evidence

`tests/account-service/` exercises free/trial limits under concurrent
registration, status changes, HMAC tampering/freshness/prices, idempotence/event
ordering, durable revocation and persistence failure, actual relay tunnel
closure, owner-audience isolation, signed-device replay/purpose isolation,
WorkOS failure handling and metadata canaries. Local stdio and loopback SDK
clients execute filesystem tools with no account or subscription. Existing
WP-32 TLS/Chromium acceptance now uses a real AccountService trial, not an
always-entitled hook. Tests are offline/emulated provider evidence, not live
WorkOS/Stripe or public-host acceptance.

### Repository qualification (2026-10-20)

On implementation commit `18baf004`, local `npm run check` passed: core
**2083 passed / 218 platform-gated skipped**, extension **186 passed**. Real
Chromium `npm run test:e2e:browser` passed **55 / 3 headed-only skipped**, including
WP-32 all three protocol revisions × both presets against real AccountService.
Skipped local native/headed cases are not counted as qualification; the PR CI
contains six OS/Node jobs, four installed-L1 Linux x64/ARM64 jobs, and real Chromium.
Final-head CI is the merge/review gate on PR #37.
