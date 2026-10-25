import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { ScratchDirectorySchema, prepareScratchDirectory } from "../../src/core/platform/scratch-directory.js";
it("refuses traversal, secrets and platform-ambiguous cwd and defaults to root", () => {
  expect(ScratchDirectorySchema.parse(undefined)).toBe(".");
  expect(ScratchDirectorySchema.parse("renders/preview")).toBe("renders/preview");
  for (const cwd of [
    "..",
    "a/../b",
    "a/./b",
    "/tmp",
    "C:/tmp",
    "a\\b",
    "a//b",
    "a/.env",
    "a/x.pem",
    "a/NUL",
    "a/",
    "a ",
  ])
    expect(ScratchDirectorySchema.safeParse(cwd).success, cwd).toBe(false);
});
it("creates canonical nested scratch directories but rejects symlink/junction ancestors and non-directories", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crot-scratch-cwd-"));
  const root = path.join(base, "work"),
    outside = path.join(base, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    expect(await prepareScratchDirectory(root, "renders/preview")).toBe(
      path.join(await realpath(root), "renders", "preview"),
    );
    await symlink(outside, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareScratchDirectory(root, "alias/new")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await writeFile(path.join(root, "file"), "not a directory");
    await expect(prepareScratchDirectory(root, "file/new")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
