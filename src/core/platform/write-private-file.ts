/** Shared owner-private atomic write primitive; Core never imports service secret backends. */
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import type { PrivateFileProtection } from "./types.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write `content` to `file` atomically through a private temporary file: it
 * is created owner-only (mode 0600; on platforms that restrict files after
 * creation it is restricted while still empty), filled and renamed over the
 * target. Readers never see a partial value. Failure to restrict is an error,
 * never a silent downgrade.
 */
export async function writePrivateFileAtomic(
  file: string,
  content: string | Uint8Array,
  privateFiles: PrivateFileProtection,
): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
  try {
    if (privateFiles.protectFile) {
      await writeFile(tmp, "", { flag: "wx", ...mode });
      await privateFiles.protectFile(tmp);
      await writeFile(tmp, content, { encoding: "utf8", flag: "r+" });
    } else {
      await writeFile(tmp, content, { encoding: "utf8", flag: "wx", ...mode });
    }
    // Windows: a reader holding the target open makes the replacement fail briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await sleep(50);
      }
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
