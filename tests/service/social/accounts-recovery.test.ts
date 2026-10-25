import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import {
  SocialAccountService,
  AccountAuthorizationError,
  type SocialAccount,
} from "../../../src/service/social/accounts.js";
import { productionOAuthAdapters } from "../../../src/service/social/provider-http.js";
function fixture() {
  const values = new Map<string, string>([
    ["githubaccess", "private-access"],
    ["githubrefresh", "private-refresh"],
  ]);
  let deleteFails = false;
  const snapshots: SocialAccount[][] = [],
    audits: string[] = [];
  const secrets = new AccountSecrets({
    kind: "secret-service",
    get: async (p, f) => values.get(p + f),
    set: async (p, f, v) => {
      values.set(p + f, v);
    },
    delete: async (p, f) => {
      if (deleteFails) throw new Error("store unavailable");
      values.delete(p + f);
    },
  });
  const service = new SocialAccountService(
    {
      secrets: async () => secrets,
      persist: async (rows) => {
        snapshots.push(structuredClone([...rows]));
      },
      audit: async (e) => {
        audits.push(e.operation);
      },
      openBrowser: async () => {
        throw new Error("not used");
      },
    },
    productionOAuthAdapters(),
  );
  const metadata = service.list();
  Object.assign(
    metadata.find((a) => a.provider === "github")!,
    { clientId: "app", id: "github:42", handle: "@fixture", state: "connected" },
  );
  return {
    service,
    metadata,
    snapshots,
    audits,
    failDelete: () => {
      deleteFails = true;
    },
  };
}
it("restores only complete strict metadata and rejects credential-bearing or duplicate records", async () => {
  const f = fixture();
  f.service.restore(f.metadata);
  expect(await f.service.withCredential("github", async (access) => access === "private-access")).toBe(true);
  await f.service.close();
  const bad = fixture();
  expect(() => bad.service.restore(bad.metadata.map((a) => ({ ...a, access: "leak" })))).toThrow();
  expect(() => bad.service.restore([...bad.metadata.slice(0, 4), bad.metadata[0]])).toThrow("Duplicate");
  const broken = structuredClone(bad.metadata);
  delete broken.find((a) => a.provider === "github")!.id;
  expect(() => bad.service.restore(broken)).toThrow("Incomplete");
  expect(() => bad.service.restore([{ provider: "github", generation: randomUUID() }])).toThrow();
  await bad.service.close();
});
it("failed cleanup persists restricted metadata and cannot grant another credential lease", async () => {
  const f = fixture();
  f.service.restore(f.metadata);
  f.failDelete();
  await expect(
    f.service.withCredential("github", async () => {
      throw new AccountAuthorizationError("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(f.service.list().find((a) => a.provider === "github")).toMatchObject({
    state: "restricted",
    cleanup: "failed",
    restriction: "secret_cleanup_failed",
  });
  expect(f.snapshots.at(-1)?.find((a) => a.provider === "github")?.state).toBe("restricted");
  expect(f.audits).toContain("account.reauth_required");
  let called = false;
  await expect(
    f.service.withCredential("github", async () => {
      called = true;
    }),
  ).rejects.toThrow("authorization");
  expect(called).toBe(false);
  await f.service.close();
});
