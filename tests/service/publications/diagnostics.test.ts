import path from "node:path";
import { expect, it, vi } from "vitest";
import { ProductRuntime } from "../../../src/service/product-runtime.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../../src/service/secrets/store.js";
import type { ConfinementStatus } from "../../../src/core/platform/types.js";
import { createTestCore, makeTempDirs } from "../../helpers.js";

it("system.check describes AD-61 honestly and fails closed after refresh errors despite cached success", async () => {
  const dirs = await makeTempDirs();
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const stateDir = path.join(dirs.outside, "publication-diagnostics");
  const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
  const mechanisms = { linux: "linux-bubblewrap", darwin: "macos-seatbelt", win32: "windows-appcontainer" } as const;
  const ready: ConfinementStatus = {
    sourceAccess: "core-only",
    available: true,
    reason: null,
    network: "on",
    mechanism: mechanisms[process.platform as keyof typeof mechanisms],
    detail: "AD-58 scratch",
  };
  const refresh = vi.spyOn(core, "refreshConfinement").mockResolvedValue(ready);
  const cached = vi.spyOn(core, "confinementStatus").mockReturnValue(ready);
  let runtime: ProductRuntime | undefined;
  try {
    runtime = await ProductRuntime.open({
      stateDir,
      privateFiles,
      secrets: store,
      core: () => core,
      selectWorkspace: async () => {},
    });
    const check = async () =>
      (await runtime!.request("system.check", {})).report as {
        l1: ConfinementStatus;
        nativeCommandPrerequisiteMet: boolean;
        publicationProtection: {
          production: string;
          nativeCredentialControlIsolation: string;
          commandNetworkOn: string;
        };
      };
    expect(await check()).toMatchObject({
      nativeCommandPrerequisiteMet: true,
      publicationProtection: {
        nativeCredentialControlIsolation: "ready",
        commandNetworkOn: "owner_enabled_raw_network_no_dpi",
        production: "requires_verified_pro_and_owner_confirmation",
      },
    });
    refresh.mockRejectedValueOnce(new Error("private-path-secret"));
    const failed = await check();
    expect(failed).toMatchObject({
      l1: { available: false, reason: "self_test_failed" },
      nativeCommandPrerequisiteMet: false,
      publicationProtection: { nativeCredentialControlIsolation: "unavailable", production: "fail_closed" },
    });
    expect(JSON.stringify(failed)).not.toContain("private-path-secret");
    refresh.mockResolvedValueOnce({ ...ready, sourceAccess: undefined });
    expect((await check()).publicationProtection.production).toBe("fail_closed");
    refresh.mockResolvedValueOnce({ ...ready, available: false, reason: "components_missing" });
    expect((await check()).publicationProtection.production).toBe("fail_closed");
  } finally {
    refresh.mockRestore();
    cached.mockRestore();
    await runtime?.close();
    await core.shutdown();
    await dirs.cleanup();
  }
});
