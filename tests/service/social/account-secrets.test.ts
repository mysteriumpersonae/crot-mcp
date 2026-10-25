import { expect, it } from "vitest";
import { AccountSecrets, type AccountSecretBackend } from "../../../src/service/social/account-secrets.js";
it("round-trips credentials only in the selected OS backend and verifies complete deletion even after failures", async () => {
  const data = new Map<string, string>();
  let refuse = false;
  const deleted: string[] = [];
  const backend: AccountSecretBackend = {
    kind: "secret-service",
    get: async (p, f) => data.get(p + f),
    set: async (p, f, v) => {
      data.set(p + f, v);
    },
    delete: async (p, f) => {
      deleted.push(f);
      if (refuse && f === "access") throw new Error("store locked");
      data.delete(p + f);
    },
  };
  const store = new AccountSecrets(backend);
  await store.write("youtube", "access", "access-token");
  await store.write("youtube", "refresh", "refresh-token");
  await store.write("youtube", "clientSecret", "client-secret");
  expect(await store.read("youtube", "access")).toBe("access-token");
  refuse = true;
  await expect(store.clear("youtube")).rejects.toThrow("completely removed");
  expect(deleted.sort()).toEqual(["access", "clientSecret", "refresh"]);
  expect(data.has("youtuberefresh")).toBe(false);
  refuse = false;
  await store.clear("youtube");
  expect(data.size).toBe(0);
  await expect(store.write("youtube", "access", "x\nsecret")).rejects.toThrow("Invalid");
  await expect(store.write("youtube", "access", "x".repeat(2561))).rejects.toThrow("Invalid");
});
it("rejects failed read-back rather than pretending a token was saved", async () => {
  const store = new AccountSecrets({
    kind: "keychain",
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
  });
  await expect(store.write("github", "access", "secret-token")).rejects.toThrow("read-back");
});
it("never propagates an OS-tool error that could echo sensitive input", async () => {
  const store = new AccountSecrets({
    kind: "keychain",
    get: async () => {
      throw new Error("leaked-secret-token");
    },
    set: async () => {
      throw new Error("leaked-secret-token");
    },
    delete: async () => {
      throw new Error("leaked-secret-token");
    },
  });
  for (const action of [
    () => store.read("github", "access"),
    () => store.write("github", "access", "some-value"),
    () => store.clear("github"),
  ]) {
    try {
      await action();
      throw new Error("Expected refusal");
    } catch (error) {
      expect(String(error)).not.toContain("leaked-secret-token");
      expect(String(error)).not.toContain("Expected refusal");
    }
  }
});
