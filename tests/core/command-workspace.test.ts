/** Composition tests use a stub native provider: NOT OS isolation evidence. */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { ConfinementScope, ConfinementStatus } from "../../src/core/platform/types.js";
import { createTestCore, makeTempDirs, testContext as ctx } from "../helpers.js";

const ready: ConfinementStatus = {
  mechanism: "linux-bubblewrap",
  available: true,
  network: "on",
  reason: null,
  detail: null,
};
describe("AD-58 command workspace composition", () => {
  it("maps commands into empty private scratch, forwards launcher guarantees and never imports writes", async () => {
    const d = await makeTempDirs(),
      node = await createNodePlatform();
    let scope: ConfinementScope | undefined;
    const nativeClose = vi.fn(async () => undefined);
    const core = await createTestCore(
      {
        workspace: { root: d.workspace },
        permissions: { mode: "full_control", projectSecrets: { allow: [{ workspace: d.workspace, path: ".env" }] } },
      },
      undefined,
      {
        checkedCommands: true,
        platform: {
          ...node,
          privateFiles: {
            ...node.privateFiles,
            ensureDirectory: async () => undefined,
            inspect: async () => ({ ownerOnly: true, mechanism: "posix-mode", detail: "unit stub" }),
          },
          confinement: {
            probe: async () => ready,
            open: async (s) => {
              scope = s;
              return {
                launcher: node.launcher,
                status: () => ready,
                refresh: async () => ready,
                close: nativeClose,
                closeSync: () => undefined,
              };
            },
          },
        },
      },
    );
    try {
      expect(scope!.workspace).not.toBe(d.workspace);
      expect(scope!.protectedPaths).toContain(d.workspace);
      expect(scope!.projectSecretAllowedPaths).toEqual([]);
      await writeFile(path.join(d.workspace, "public.txt"), "source");
      const r = await core.processes.exec(ctx, {
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('private.txt','scratch');console.log(process.cwd())"],
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(scope!.workspace);
      await expect(access(path.join(d.workspace, "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("source");
      await core.filesystem.writeFile(ctx, { path: "public.txt", content: "checked" });
      expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("checked");
      await mkdir(path.join(d.workspace, "nested"));
      await expect(
        core.processes.exec(ctx, { command: process.execPath, args: ["-e", "0"], cwd: "nested" }),
      ).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      expect(core.confinementStatus()).toMatchObject({ available: true, sourceAccess: "core-only" });
      expect(core.confinementStatus().detail).not.toContain("Full Control");
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
    expect(nativeClose).toHaveBeenCalledTimes(1);
    await expect(access(scope!.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses Full Control exec/shell/start/stdio without native L1 and never calls the host launcher", async () => {
    const d = await makeTempDirs(),
      node = await createNodePlatform();
    const launch = vi.fn(node.launcher.launch.bind(node.launcher));
    const core = await createTestCore(
      { workspace: { root: d.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { checkedCommands: true, platform: { ...node, launcher: { ...node.launcher, launch }, confinement: undefined } },
    );
    try {
      for (const run of [
        () => core.processes.exec(ctx, { command: process.execPath, args: ["-e", "0"] }),
        () => core.processes.shell(ctx, { script: "echo unsafe" }),
        () => core.processes.start(ctx, { command: process.execPath, args: ["-e", "0"] }),
        () => core.processes.openTransport(ctx, { command: process.execPath, args: [], cwd: d.workspace }),
      ])
        await expect(run()).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
      expect(launch).not.toHaveBeenCalled();
      expect(core.confinementStatus()).toMatchObject({ available: false, sourceAccess: "core-only" });
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });
});
