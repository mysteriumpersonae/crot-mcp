/** AD-58 Core checks, not native sandbox qualification. */
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestCore, makeTempDirs, testContext as ctx } from "../helpers.js";

describe("AD-58 checked live source operations", () => {
  it("writes and atomic-moves public files while refusing existing/future secret destinations", async () => {
    const d = await makeTempDirs();
    const core = await createTestCore(
      { workspace: { root: d.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { checkedCommands: true },
    );
    try {
      await core.filesystem.writeFile(ctx, { path: "public.txt", content: "before" });
      await core.filesystem.writeFile(ctx, { path: "atomic.tmp", content: "after" });
      await core.filesystem.move(ctx, { from: "atomic.tmp", to: "public.txt", overwrite: true });
      expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("after");
      for (const name of [".env", ".envrc", ".ENVbackup", "future.pem", "future.KEY"]) {
        await expect(core.filesystem.writeFile(ctx, { path: name, content: "bad" })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
        await writeFile(path.join(d.workspace, name), "host-secret");
        await expect(core.filesystem.readFile(ctx, { path: name })).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
        await expect(
          core.filesystem.move(ctx, { from: "public.txt", to: name, overwrite: true }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        await expect(
          core.filesystem.move(ctx, { from: name, to: "public.txt", overwrite: true }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(await readFile(path.join(d.workspace, name), "utf8")).toBe("host-secret");
      }
      expect(await readFile(path.join(d.workspace, "public.txt"), "utf8")).toBe("after");
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });
  it("refuses hardlink reads/writes before truncation and directory moves/deletes containing secrets", async () => {
    const d = await makeTempDirs();
    const core = await createTestCore(
      { workspace: { root: d.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { checkedCommands: true },
    );
    try {
      await writeFile(path.join(d.workspace, ".env"), "keep-secret");
      await link(path.join(d.workspace, ".env"), path.join(d.workspace, "alias.txt"));
      await expect(core.filesystem.readFile(ctx, { path: "alias.txt" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(core.filesystem.writeFile(ctx, { path: "alias.txt", content: "truncate" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(await readFile(path.join(d.workspace, ".env"), "utf8")).toBe("keep-secret");
      await mkdir(path.join(d.workspace, "tree"));
      await writeFile(path.join(d.workspace, "tree", "server.key"), "keep-key");
      await expect(core.filesystem.move(ctx, { from: "tree", to: "moved" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(core.filesystem.delete(ctx, { path: "tree", recursive: true })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(await readFile(path.join(d.workspace, "tree", "server.key"), "utf8")).toBe("keep-key");
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });
  it("retains only exact owner file opt-ins for checked Core, not sibling secrets", async () => {
    const d = await makeTempDirs();
    const core = await createTestCore(
      {
        workspace: { root: d.workspace },
        permissions: { mode: "full_control", projectSecrets: { allow: [{ workspace: d.workspace, path: ".env" }] } },
      },
      undefined,
      { checkedCommands: true },
    );
    try {
      await writeFile(path.join(d.workspace, ".env"), "approved");
      await writeFile(path.join(d.workspace, ".env.local"), "unapproved");
      expect((await core.filesystem.readFile(ctx, { path: ".env" })).content).toBe("approved");
      await expect(core.filesystem.readFile(ctx, { path: ".env.local" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    } finally {
      await core.shutdown();
      await d.cleanup();
    }
  });
});
