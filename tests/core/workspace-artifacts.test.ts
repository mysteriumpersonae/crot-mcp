/** Composition uses a stub native provider; actual OS gates live in native-host. */
import { mkdir, writeFile, readFile, link, rm, access } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ArtifactPathSchema, readWorkspaceArtifacts } from "../../src/core/platform/workspace-artifacts.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { createTestCore, makeTempDirs, testContext as ctx, linkDirectory } from "../helpers.js";
describe("AD-59 checked artifact export", () => {
  it("rejects portable secret/traversal/stream/control paths", () => {
    for (const p of [
      "../x",
      "/x",
      "a//x",
      ".envrc",
      "certs/FUTURE.KEY",

      "a\\b",
      "x:stream",
      ".git/hooks/x",
      "aux.txt",
    ]) {
      expect(ArtifactPathSchema.safeParse(p).success, p).toBe(false);
    }
    expect(ArtifactPathSchema.safeParse("assets/video.mp4").success).toBe(true);
  });
  it("rejects source hardlinks and directory aliases before copying bytes", async () => {
    const d = await makeTempDirs();
    try {
      await writeFile(path.join(d.workspace, "plain"), "secret");
      await link(path.join(d.workspace, "plain"), path.join(d.workspace, "alias"));
      await expect(readWorkspaceArtifacts(d.workspace, ["alias"])).rejects.toThrow();
      await linkDirectory(d.outside, path.join(d.workspace, "jump"));
      await writeFile(path.join(d.outside, "outside"), "private");
      await expect(readWorkspaceArtifacts(d.workspace, ["jump/outside"])).rejects.toThrow();
    } finally {
      await d.cleanup();
    }
  });
  it("exports binary bytes through Core, retains failed export for retry and refuses intervening writes", async () => {
    const d = await makeTempDirs(),
      node = await createNodePlatform();
    let scratch = "";
    const core = await createTestCore(
      { workspace: { root: d.workspace }, permissions: { mode: "full_control" } },
      undefined,
      {
        checkedCommands: true,
        platform: {
          ...node,
          privateFiles: {
            ...node.privateFiles,
            ensureDirectory: async (p) => {
              await mkdir(p, { recursive: true, mode: 0o700 });
            },
            inspect: async () => ({ ownerOnly: true, mechanism: "posix-mode", detail: "unit stub" }),
          },
          confinement: {
            probe: async () => ({
              mechanism: "linux-bubblewrap",
              available: true,
              network: "on",
              reason: null,
              detail: null,
            }),
            open: async (s) => {
              scratch = s.workspace;
              const status = {
                mechanism: "linux-bubblewrap" as const,
                available: true,
                network: "on" as const,
                reason: null,
                detail: null,
              };
              return {
                launcher: node.launcher,
                status: () => status,
                refresh: async () => status,
                close: async () => undefined,
                closeSync: () => undefined,
              };
            },
          },
        },
      },
    );
    try {
      const bytes = Buffer.from([0, 255, 0, 17, 99]);
      await writeFile(path.join(scratch, "render.mp4"), bytes);
      await writeFile(path.join(d.workspace, "render.mp4"), "original");
      await expect(core.syncWorkspaceArtifacts(ctx, { files: ["render.mp4"] })).rejects.toThrow();
      expect(core.confinementStatus()).toMatchObject({ available: false, reason: "artifact_export_pending" });
      expect(core.artifactStatus()).toMatchObject({ pending: true, recoveryDirectory: scratch });
      expect(await readFile(path.join(scratch, "render.mp4"))).toEqual(bytes);
      expect(await readFile(path.join(d.workspace, "render.mp4"), "utf8")).toBe("original");
      await expect(core.filesystem.writeFile(ctx, { path: "other", content: "bad" })).rejects.toMatchObject({
        code: "CONFINEMENT_FAILED",
      });
      const result = await core.syncWorkspaceArtifacts(ctx, { files: ["render.mp4"], overwrite: true });
      expect(result.written[0]?.bytesWritten).toBe(bytes.length);
      expect(await readFile(path.join(d.workspace, "render.mp4"))).toEqual(bytes);
      await expect(access(scratch)).rejects.toThrow();
      await core.filesystem.writeFile(ctx, { path: "other", content: "ok" });
    } finally {
      await core.shutdown();
      await d.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
