import { expect, it, vi } from "vitest";
import { buildSecretViewFixture } from "./diagnostics/secret-view-build.js";

it("AD-57 refuses retired driver provisioning before any download on every host", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(buildSecretViewFixture()).rejects.toThrow(
      "AD-57: third-party filesystem driver provisioning is disabled",
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
