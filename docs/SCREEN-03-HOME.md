# Home dashboard composition

Home retains the shipped CROT mascot, semantic tokens and icon set. Only Home's
content and its header frame are restyled; the other workspace screens keep their
layouts. The sidebar navigation is unchanged except for a Live badge sourced from
the local bridge connection state.

Four tinted capability cards surround the AI Core sphere on wide desktop windows.
Orbit rings and four SVG curves are decorative, not service-health indicators.
Each card is one keyboard-accessible navigation action; its service mini-tiles are
illustrations, not claims that those providers are connected or implemented natively.
Unknown brand marks use neutral existing tool icons or a text monogram, not invented
logos. No After Effects integration or icon is added. Narrow layouts stack the core
and cards and omit crossing curves, without hiding card actions.

The Home header contains emergency stop, real approval count, avatar disclosure
(profile and sign out), and current Free/Pro badge. Unknown/unverified entitlement
never renders Pro. The bridge footer and expandable connection-status panel use
TrayView/CrotService values. First-run setup is available as a localized modal from
this panel; there is no top-of-page onboarding request/loading placeholder.

The old recent-projects/connector panels are not part of this composition. Their
full functions remain in Projects and Connectors. The Home upgrade action opens the
existing plan selector and uses the canonical plan catalog, not the reference's
illustrative price. Opening a public website never grants a subscription.

Desktop account, install and trial links now use https://crot.network/ rather than
the legacy relay staging portal. Trial carries only the non-secret intent=trial
query. Existing verified-entitlement and pairing gates remain in force; this change
does not deploy billing or remove the relay backend's authenticated APIs.

Verification: the real Chromium UI scenario checks four cards, sixteen tiles,
four curves/eight endpoints, connected/offline Live state, avatar Escape handling,
RU/EN, and desktop/mobile geometry. The real product-service scenario and local-auth
logout/re-login scenario remain separate regression gates. OAuth return is described
in [Screen 01](SCREEN-01-AUTH.md#oauth-browser-return-and-input-ux).
