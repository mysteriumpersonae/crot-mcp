/** Production release environment: crot.network (own auth, no WorkOS dependency). */
import type { IdentityEnvironment } from "./environment.js";

/**
 * Production identity environment for crot.network.
 *
 * issuer:          https://crot.network — our own auth server at /auth/...
 *                  (Email/OTP + Google OAuth + GitHub OAuth).
 * relayHost:       crot.network — the public Cloud Relay domain.
 * pairingClientId: crot-device-v1 — the public OAuth client for device pairing (PKCE).
 *
 * For development/staging, override with CROT_IDENTITY_DEV_ENVIRONMENT pointing
 * to deploy/staging/identity.json (relay-staging.crot.network).
 *
 * This value is undefined in source; scripts/build-release.mjs replaces the
 * emitted module with the validated production environment at build time.
 * Until a release build is made with RELEASE_IDENTITY_ENVIRONMENT set,
 * development builds show "identity environment not configured" for remote access.
 */
export const RELEASE_IDENTITY_ENVIRONMENT: IdentityEnvironment | undefined = undefined;
// Production value injected by build-release.mjs:
// {
//   id: "production",
//   kind: "release",
//   issuer: "https://crot.network",
//   relayHost: "crot.network",
//   pairing: {
//     clientId: "crot-device-v1",
//     redirectPort: 0,
//     scope: "openid email profile",
//   },
// }
