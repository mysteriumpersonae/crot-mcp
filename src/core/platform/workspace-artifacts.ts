/** AD-59: bounded descriptor-checked export AFTER native actor drain. No source import. */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../errors.js";
import { isProjectSecretName } from "../permissions/project-secrets.js";
import { openTransferRead } from "../../native-host/browser-files.js";
const forbidden = (p: string) =>
  p.split("/").some((v) => isProjectSecretName(v) || [".git", ".crot"].includes(v.toLowerCase()));
export const ArtifactPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (p) =>
      !/[\\\x00-\x1f\x7f:*?"<>|]/.test(p) &&
      !forbidden(p) &&
      p
        .split("/")
        .every(
          (v) =>
            !!v &&
            v !== "." &&
            v !== ".." &&
            !/[. ]$/.test(v) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v),
        ),
    "Use a non-secret portable project-relative file path",
  );
export const SyncArtifactsSchema = z
  .object({ files: z.array(ArtifactPathSchema).min(1).max(64), overwrite: z.boolean().default(false) })
  .strict();
export type ArtifactSnapshot = { path: string; data: Buffer };
export async function readWorkspaceArtifacts(root: string, files: readonly string[]): Promise<ArtifactSnapshot[]> {
  const result: ArtifactSnapshot[] = [];
  let bytes = 0;
  for (const name of files) {
    ArtifactPathSchema.parse(name);
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (current !== path.join(root, ...name.split("/")) && !info.isDirectory()))
        throw new CrotError("PERMISSION_DENIED", "Artifact links and special ancestors are forbidden");
    }
    const input = await openTransferRead(current);
    try {
      const before = await input.stat();
      if (!before.isFile() || before.nlink !== 1)
        throw new CrotError("PERMISSION_DENIED", "Artifact must be a single-link regular file");
      bytes += before.size;
      if (bytes > 256 * 1024 * 1024)
        throw new CrotError("LIMIT_EXCEEDED", "Artifact export exceeds 256 MiB; export smaller selections");
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const r = await input.read(data, offset, Math.min(65536, data.length - offset), offset);
        if (!r.bytesRead) throw new CrotError("OPERATION_FAILED", "Artifact changed during capture");
        offset += r.bytesRead;
      }
      const after = await input.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new CrotError("OPERATION_FAILED", "Artifact changed during capture");
      result.push({ path: name, data });
    } finally {
      await input.close();
    }
  }
  return result;
}
