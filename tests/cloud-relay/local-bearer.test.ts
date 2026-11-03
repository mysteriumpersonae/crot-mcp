import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { deviceIdForPublicKey } from "../../src/identity/device-id.js";
import { loadOrCreateLocalDeviceIdentity } from "../../src/service/local-device-id.js";

describe("self-registered local device identity", () => {
  it("is key-derived and persists across loads", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crot-lid-"));
    try {
      const files = createPrivateFileProtection(process.platform === "win32");
      const a = await loadOrCreateLocalDeviceIdentity(dir, files);
      const b = await loadOrCreateLocalDeviceIdentity(dir, files);
      expect(a.localDeviceId).toMatch(/^[a-z2-7]{26}$/);
      expect(b.localDeviceId).toBe(a.localDeviceId);
      expect(deviceIdForPublicKey(a.publicKey.x)).toBe(a.localDeviceId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
