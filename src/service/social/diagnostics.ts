/** Non-secret facts only. Missing vendor evidence is explicitly unknown, not success. */
import type { SocialAccount } from "./accounts.js";
import { SOCIAL_OAUTH_ENDPOINTS } from "./provider-http.js";
export function accountDiagnostics(account: Readonly<SocialAccount>) {
  const requiredScopes = [...SOCIAL_OAUTH_ENDPOINTS[account.provider].scopes];
  const grantedScopes = account.grantedScopes ? [...account.grantedScopes] : undefined;
  const missingScopes = grantedScopes ? requiredScopes.filter((scope) => !grantedScopes.includes(scope)) : undefined;
  return {
    provider: account.provider,
    state: account.state,
    checkedAt: account.checkedAt,
    restriction: account.restriction,
    scopes: {
      status: grantedScopes === undefined ? "not_reported" : missingScopes?.length ? "missing" : "granted",
      required: requiredScopes,
      granted: grantedScopes,
      missing: missingScopes,
    },
    publication:
      account.provider === "tiktok"
        ? "inbox_draft_only"
        : ["youtube", "x"].includes(account.provider)
          ? "owner_confirmation_required"
          : "not_supported",
    ...(account.provider === "youtube"
      ? {
          channel: account.id && account.checkedAt ? "profile_verified" : "not_verified",
          // Listing a channel cannot prove remaining upload quota. Never manufacture a quota estimate.
          uploadQuota: account.restriction === "youtube_quota_exceeded" ? "exceeded" : "not_reported",
        }
      : {}),
    ...(account.provider === "x"
      ? {
          // A successful /users/me is not evidence of paid write-tier access.
          writeTier: account.restriction === "provider_api_access_restricted" ? "restricted" : "not_verified",
        }
      : {}),
  };
}
