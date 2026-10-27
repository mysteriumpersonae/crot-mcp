import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, link, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { controllerProtectedPaths } from "../../../src/native-host/windows-l1/controller-files.js";
import type { PrivateFileProtection } from "../../../src/core/platform/types.js";
const privateFiles: PrivateFileProtection = {
  mechanism: "windows-acl",
  enforced: true,
  fileMode: undefined,
  ensureDirectory: async () => undefined,
  inspect: async () => ({ mechanism: "windows-acl", ownerOnly: true, detail: "native double for policy test only" }),
};
describe("fixed controller-file policy (not native isolation evidence)", () => {
  it("only separates exact internal controller names, never config, secrets or project names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "controller-policy-"));
    try {
      const controller = path.join(root, "product-vault.enc");
      await writeFile(controller, "private");
      const paths = [
        controller,
        path.join(root, "control-token"),
        path.join(root, ".env"),
        path.join(root, "elsewhere", "product-vault.enc"),
        path.join(root, "publication-media"),
      ];
      expect(await controllerProtectedPaths(root, paths, privateFiles)).toEqual(paths.slice(1));
      await expect(
        controllerProtectedPaths(root, [controller], {
          ...privateFiles,
          inspect: async () => ({ mechanism: "windows-acl", ownerOnly: false, detail: "bad" }),
        }),
      ).rejects.toThrow("verified");
      await expect(controllerProtectedPaths(root, [], { ...privateFiles, enforced: false })).rejects.toThrow(
        "enforcement",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses hardlink identity aliases and unexpected directory objects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "controller-policy-"));
    try {
      const controller = path.join(root, "product-vault.enc");
      await writeFile(controller, "private");
      await link(controller, path.join(root, "alias"));
      await expect(controllerProtectedPaths(root, [controller], privateFiles)).rejects.toThrow("single-link");
      const directory = path.join(root, "product-state.json");
      await mkdir(directory);
      await expect(controllerProtectedPaths(root, [directory], privateFiles)).rejects.toThrow("private object");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
