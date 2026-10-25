/** Composition tests use a stub native provider: NOT OS isolation evidence. */
import { access, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openCommandWorkspace } from "../../src/core/platform/command-workspace.js";
import { Workspace } from "../../src/core/workspace/workspace.js";
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
  it("launches in a canonical scratch subdirectory, retains artifacts and recovers from a refused link cwd", async () => {
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
            ensureDirectory: async (dir) => {
              await mkdir(dir, { recursive: true, mode: 0o700 });
            },
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
      const result = await core.processes.execInScratch(
        ctx,
        {
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('clip.bin',Buffer.from([0,255,3]));console.log(process.cwd())"],
        },
        "renders/preview",
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(path.join(scope!.workspace, "renders", "preview"));
      await expect(access(path.join(d.workspace, "renders"))).rejects.toMatchObject({ code: "ENOENT" });
      await symlink(
        d.workspace,
        path.join(scope!.workspace, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        core.processes.execInScratch(
          ctx,
          { command: process.execPath, args: ["-e", "process.exit(99)"] },
          "alias/escape",
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await core.refreshConfinement();
      const restored = await core.processes.exec(ctx, {
        command: process.execPath,
        args: ["-e", "console.log('RESTORED')"],
      });
      expect(restored.exitCode).toBe(0);
      expect(restored.stdout).toContain("RESTORED");
      await core.syncWorkspaceArtifacts(ctx, { files: ["renders/preview/clip.bin"] });
      expect(await readFile(path.join(d.workspace, "renders/preview/clip.bin"))).toEqual(Buffer.from([0, 255, 3]));
      expect(nativeClose).toHaveBeenCalled();
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });

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
            ensureDirectory: async (dir) => {
              await mkdir(dir, { recursive: true, mode: 0o700 });
            },
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
      await expect(core.git.status(ctx, {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(launch).not.toHaveBeenCalled();
      expect(core.confinementStatus()).toMatchObject({ available: false, sourceAccess: "core-only" });
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });
  it("serializes source mutation with native teardown, rotates scratch and refuses stale resolved commands", async () => {
    const d = await makeTempDirs(),
      node = await createNodePlatform();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const close = vi.fn(async () => gate),
      launch = vi.fn(node.launcher.launch.bind(node.launcher));
    const c = await openCommandWorkspace(
      {
        ...node,
        privateFiles: {
          ...node.privateFiles,
          ensureDirectory: async (dir) => {
            await mkdir(dir, { recursive: true, mode: 0o700 });
          },
          inspect: async () => ({ ownerOnly: true, mechanism: "posix-mode", detail: "unit stub" }),
        },
        confinement: {
          probe: async () => ready,
          open: async () => ({
            status: () => ready,
            refresh: async () => ready,
            launcher: { ...node.launcher, launch },
            close,
            closeSync: () => undefined,
          }),
        },
      },
      await Workspace.open(d.workspace),
      { workspace: d.workspace, protectedPaths: [], network: "on", dockerEnvironment: {}, audit: () => undefined },
    );
    try {
      const options = { cwd: d.workspace, env: node.baseEnvironment as Record<string, string> };
      const spec = await c.launcher.resolveCommand(process.execPath, ["-e", "0"], options);
      const sourceWrite = vi.fn(async () => undefined);
      const writing = c.withSourceMutation!(sourceWrite);
      await new Promise((r) => setTimeout(r, 10));
      expect(close).toHaveBeenCalledOnce();
      expect(sourceWrite).not.toHaveBeenCalled();
      const stale = c.launcher.launch(spec, { ...options, stdin: false });
      release();
      await writing;
      expect(sourceWrite).toHaveBeenCalledOnce();
      await expect(stale).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      expect(launch).not.toHaveBeenCalled();
      const fresh = await c.launcher.resolveCommand(process.execPath, ["-e", "0"], options);
      const child = await c.launcher.launch(fresh, { ...options, stdin: false });
      await child.exited;
      expect(launch).toHaveBeenCalledOnce();
    } finally {
      release();
      await c.close();
      await d.cleanup();
    }
  });
  it("does not run a source write or allow another launch after native drain failure", async () => {
    const d = await makeTempDirs(),
      node = await createNodePlatform();
    let broken = true;
    const c = await openCommandWorkspace(
      {
        ...node,
        privateFiles: {
          ...node.privateFiles,
          ensureDirectory: async (dir) => {
            await mkdir(dir, { recursive: true, mode: 0o700 });
          },
          inspect: async () => ({ ownerOnly: true, mechanism: "posix-mode", detail: "unit stub" }),
        },
        confinement: {
          probe: async () => ready,
          open: async () => ({
            status: () => ready,
            refresh: async () => ready,
            launcher: node.launcher,
            close: async () => {
              if (broken) throw Error("unit drain failure");
            },
            closeSync: () => undefined,
          }),
        },
      },
      await Workspace.open(d.workspace),
      { workspace: d.workspace, protectedPaths: [], network: "on", dockerEnvironment: {}, audit: () => undefined },
    );
    try {
      const write = vi.fn(async () => undefined);
      await expect(c.withSourceMutation!(write)).rejects.toThrow("unit drain failure");
      expect(write).not.toHaveBeenCalled();
      await expect(
        c.launcher.resolveCommand(process.execPath, [], { cwd: d.workspace, env: {} }),
      ).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      expect(c.status().available).toBe(false);
    } finally {
      broken = false;
      await c.close();
      await d.cleanup();
    }
  });
});
