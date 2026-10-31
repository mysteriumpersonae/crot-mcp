import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AsyncEntry } from "@napi-rs/keyring";
const enabled = process.platform !== "linux" || process.env.CROT_TEST_SECRET_SERVICE === "1";
describe.skipIf(!enabled)("native OS credential store (synthetic record only)", () => {
  it("persists across entry instances and deletes without file fallback", async () => {
    const service = "CROT.Test.Auth." + randomUUID();
    const make = () => new AsyncEntry(service, "fixture-owner", { linux: { store: "secret-service" } });
    const entry = make();
    try {
      expect(await entry.getPassword()).toBeNull();
      await entry.setPassword("synthetic-not-a-live-secret");
      expect(await make().getPassword()).toBe("synthetic-not-a-live-secret");
      expect(await make().deleteCredential()).toBe(true);
      expect(await entry.getPassword()).toBeNull();
    } finally {
      await entry.deleteCredential();
    }
  }, 20_000);
});
