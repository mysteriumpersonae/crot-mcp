import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { accountStoreDescriptor } from "../../../src/service/social/account-secrets.js";
import { makeTempDirs } from "../../helpers.js";
it("keeps the independent OAuth Keychain descriptor when generic service secrets migrate to file storage", async () => {
  const dirs = await makeTempDirs(),
    privateFiles = createPrivateFileProtection(process.platform === "win32");
  try {
    const state = path.join(dirs.outside, "state");
    await privateFiles.ensureDirectory(state);
    await writeFile(
      path.join(state, "secrets.json"),
      JSON.stringify({ version: 1, backend: "keychain", keychain: "/owner/custom.keychain-db" }),
    );
    const selected = await accountStoreDescriptor(state, privateFiles, "darwin");
    expect(selected).toMatchObject({ kind: "keychain", keychain: "/owner/custom.keychain-db" });
    await writeFile(path.join(state, "secrets.json"), JSON.stringify({ version: 1, backend: "file" }));
    expect(await accountStoreDescriptor(state, privateFiles, "darwin")).toEqual(selected);
    expect(await readFile(path.join(state, "oauth-secret-store.json"), "utf8")).not.toContain("token");
    await expect(accountStoreDescriptor(state, privateFiles, "win32")).rejects.toThrow("migration");
    await writeFile(path.join(state, "oauth-secret-store.json"), JSON.stringify({ version: 1, kind: "file" }));
    await expect(accountStoreDescriptor(state, privateFiles, "darwin")).rejects.toThrow();
  } finally {
    await dirs.cleanup();
  }
});
