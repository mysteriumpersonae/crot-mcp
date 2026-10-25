import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import { createCredentialManager } from "../../../src/service/social/credential-manager.js";
it.skipIf(process.platform !== "win32")(
  "native Credential Manager stores, reads and removes OAuth credentials without a credential file",
  async () => {
    const store = new AccountSecrets(await createCredentialManager("CROT-account-qualification-" + randomUUID()));
    try {
      await store.write("github", "access", "fixture-access-token");
      await store.write("github", "refresh", "fixture-refresh-token");
      await store.write("github", "clientSecret", "fixture-app-secret");
      expect(await store.read("github", "access")).toBe("fixture-access-token");
    } finally {
      await store.clear("github");
    }
    for (const field of ["access", "refresh", "clientSecret"] as const)
      expect(await store.read("github", field)).toBeUndefined();
  },
);
