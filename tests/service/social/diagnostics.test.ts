import { expect, it } from "vitest";
import { accountDiagnostics } from "../../../src/service/social/diagnostics.js";
import type { SocialAccount } from "../../../src/service/social/accounts.js";
const account: SocialAccount = {
  provider: "youtube",
  state: "connected",
  generation: "test",
  id: "youtube:42",
  checkedAt: 1,
};
it("reports unknown scopes/quota instead of fabricating write permission from a verified channel", () => {
  expect(accountDiagnostics(account)).toMatchObject({
    scopes: { status: "not_reported" },
    channel: "profile_verified",
    uploadQuota: "not_reported",
  });
  expect(accountDiagnostics({ ...account, provider: "x" })).toMatchObject({ writeTier: "not_verified" });
});
it("reports every provider, missing scopes and actual API restriction reasons without credentials", () => {
  for (const provider of ["youtube", "tiktok", "x", "github", "notion"] as const) {
    const result = accountDiagnostics({ ...account, provider, grantedScopes: [] });
    expect(result.scopes.status).toBe(provider === "notion" ? "granted" : "missing");
    expect(result).not.toHaveProperty("clientSecret");
  }
  expect(accountDiagnostics({ ...account, restriction: "youtube_quota_exceeded" })).toMatchObject({
    uploadQuota: "exceeded",
  });
  expect(accountDiagnostics({ ...account, provider: "tiktok" })).toMatchObject({ publication: "inbox_draft_only" });
});
