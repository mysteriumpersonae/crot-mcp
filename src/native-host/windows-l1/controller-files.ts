/** Fixed host controller files use native owner-only + Medium No-Read-Up, not
 * actor-lifetime identity pinning (which prevents the owner from atomic saving).
 * Source/config/unknown paths retain the full AD-29 lease, without exceptions.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
const names = new Set(["product-state.json", "product-vault.enc", "client-tokens.json", "publications.json"]);
export async function controllerProtectedPaths(
  stateDir: string,
  paths: readonly string[],
  privateFiles: PrivateFileProtection,
): Promise<string[]> {
  if (!privateFiles.enforced || privateFiles.mechanism !== "windows-acl")
    throw new CrotError(
      "CONFINEMENT_FAILED",
      "Native controller-file isolation requires Windows private-state enforcement",
    );
  const pinned: string[] = [];
  for (const file of paths) {
    const relative = path.relative(stateDir, file).toLowerCase();
    if (!names.has(relative)) {
      pinned.push(file);
      continue;
    }
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    // Missing fixed controller files are written only by private atomic writer,
    // which protects its empty temp before filling it. No agent chooses this list.
    if (!info) continue;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (await privateFiles.inspect(file)).ownerOnly !== true
    )
      throw new CrotError("CONFINEMENT_FAILED", "Controller file is not a verified single-link native private object");
  }
  return pinned;
}
