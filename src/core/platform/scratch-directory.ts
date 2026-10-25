/** Owner-selected relative cwd in private scratch, never in the live source. */
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../errors.js";
import { ArtifactPathSchema } from "./workspace-artifacts.js";
export const ScratchDirectorySchema = z.union([z.literal("."), ArtifactPathSchema]).default(".");
/** Caller must drain all sandbox actors and hold command admission until spawn. */
export async function prepareScratchDirectory(root: string, input: string): Promise<string> {
  const relative = ScratchDirectorySchema.parse(input);
  const refuse = () =>
    new CrotError(
      "PERMISSION_DENIED",
      "Scratch cwd must be a canonical directory below its private root; links are forbidden",
    );
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw refuse();
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const part of relative === "." ? [] : relative.split("/")) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw refuse();
    const actual = await realpath(current),
      expected = path.join(canonicalRoot, path.relative(root, current));
    if (actual !== expected) throw refuse();
  }
  const canonical = await realpath(current),
    rel = path.relative(canonicalRoot, canonical);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) throw refuse();
  return canonical;
}
