/** Immutable, Core-private media staging. No caller-selected staging paths or generic file API. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, opendir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PrivateFileProtection } from "../platform/types.js";
import { openTransferRead, verifyTransferIdentity } from "../../native-host/browser-files.js";
import { writePrivateFileAtomic } from "../platform/write-private-file.js";
import { ArtifactPathSchema } from "../platform/workspace-artifacts.js";
export const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const MEDIA_TOTAL_BYTES = 512 * 1024 * 1024;
const SnapshotSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    project: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    mime: z.enum(["video/mp4", "image/png", "image/jpeg", "image/webp"]),
    bytes: z.number().int().positive().max(MEDIA_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MediaSnapshot = z.infer<typeof SnapshotSchema>;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function mime(data: Buffer): MediaSnapshot["mime"] {
  if (data.length >= 12 && data.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  throw new Error("Only MP4, PNG, JPEG and WebP snapshots are supported; active document formats are refused");
}
export class PublicationMedia {
  private readonly records = new Map<string, MediaSnapshot>();
  private tail = Promise.resolve();
  private constructor(
    private readonly directory: string,
    private readonly protection: PrivateFileProtection,
  ) {}
  static async open(directory: string, protection: PrivateFileProtection): Promise<PublicationMedia> {
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error("Invalid snapshot directory");
    await protection.ensureDirectory(directory);
    const directoryEntry = await lstat(directory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) throw new Error("Invalid snapshot directory");
    await protection.protectFile?.(directory);
    if ((await protection.inspect(directory)).ownerOnly !== true)
      throw new Error("Private snapshot directory protection unavailable");
    const store = new PublicationMedia(directory, protection);
    const mediaFiles = new Set<string>();
    let entries = 0;
    for await (const entry of await opendir(directory)) {
      const name = entry.name;
      if (++entries > 192 || !/^[a-f0-9-]{36}\.(?:json|media)$/.test(name))
        throw new Error("Invalid snapshot staging entry");
      const full = path.join(directory, name),
        info = await lstat(full);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Invalid snapshot staging file");
      if (name.endsWith(".media")) {
        mediaFiles.add(name);
        continue;
      }
      if (info.size > 4096) throw new Error("Invalid snapshot manifest");
      const handle = await openTransferRead(full);
      let raw: Buffer;
      try {
        const before = await handle.stat();
        if (before.size > 4096 || before.nlink !== 1 || !before.isFile()) throw new Error("Invalid snapshot manifest");
        raw = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < raw.length) {
          const read = await handle.read(raw, offset, raw.length - offset, offset);
          if (!read.bytesRead) throw new Error("Snapshot manifest truncated");
          offset += read.bytesRead;
        }
        await verifyTransferIdentity(full, before);
        const after = await handle.stat();
        if (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
          throw new Error("Snapshot manifest changed");
      } finally {
        await handle.close();
      }
      const record = SnapshotSchema.parse(JSON.parse(raw.toString("utf8")));
      if (name !== record.id + ".json" || store.records.has(record.id)) throw new Error("Invalid snapshot identity");
      store.records.set(record.id, record);
    }
    for (const record of store.records.values()) {
      if (!mediaFiles.delete(record.id + ".media")) throw new Error("Snapshot media missing");
    }
    // A crash between media and manifest commits may leave an unreferenced blob. Never serve it.
    for (const name of mediaFiles) await rm(path.join(directory, name));
    store.assertQuota(0);
    return store;
  }
  private assertQuota(extra: number): void {
    if (
      this.records.size + (extra > 0 ? 1 : 0) > 64 ||
      [...this.records.values()].reduce((sum, r) => sum + r.bytes, 0) + extra > MEDIA_TOTAL_BYTES
    )
      throw new Error("Private media staging capacity exceeded");
  }
  get(id: string, project: string): MediaSnapshot {
    const record = this.records.get(id);
    if (!record || record.project !== project) throw new Error("Snapshot does not belong to this project");
    return structuredClone(record);
  }
  async capture(project: string, name: string, input: Buffer): Promise<MediaSnapshot> {
    ArtifactPathSchema.parse(name);
    if (!input.length || input.length > MEDIA_MAX_BYTES) throw new Error("Media snapshot exceeds 64 MiB");
    const data = Buffer.from(input); // owns its bytes; later caller mutation cannot alter the snapshot
    const record = SnapshotSchema.parse({
      version: 1,
      id: randomUUID(),
      project,
      name: path.posix.basename(name),
      bytes: data.length,
      sha256: digest(data),
      mime: mime(data),
    });
    const run = async () => {
      this.assertQuota(data.length);
      const file = path.join(this.directory, record.id + ".media");
      try {
        await writePrivateFileAtomic(file, data, this.protection);
        await writePrivateFileAtomic(
          path.join(this.directory, record.id + ".json"),
          JSON.stringify(record),
          this.protection,
        );
        this.records.set(record.id, record);
      } catch (error) {
        await rm(file, { force: true }).catch(() => undefined);
        throw error;
      }
      return structuredClone(record);
    };
    const work = this.tail.then(run, run);
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  /** Trusted failed-prepare cleanup only; never a generic filesystem/RPC operation. */
  async discard(id: string, project: string): Promise<void> {
    const work = this.tail.then(async () => {
      const record = this.get(id, project);
      // Remove manifest first. A crash leaves an orphan blob, not a committed missing snapshot.
      await rm(path.join(this.directory, record.id + ".json"));
      this.records.delete(record.id);
      await rm(path.join(this.directory, record.id + ".media"), { force: true });
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  /** Fresh descriptor + identity + SHA-256 verification. Never returns a live source path. */
  async verified(id: string, project: string): Promise<{ snapshot: MediaSnapshot; data: Buffer }> {
    const snapshot = this.get(id, project),
      file = path.join(this.directory, snapshot.id + ".media");
    const handle = await openTransferRead(file);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== snapshot.bytes)
        throw new Error("Snapshot identity changed");
      const data = Buffer.alloc(snapshot.bytes);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, Math.min(65536, data.length - offset), offset);
        if (!bytesRead) throw new Error("Snapshot truncated");
        offset += bytesRead;
      }
      const after = await handle.stat();
      await verifyTransferIdentity(file, before);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        digest(data) !== snapshot.sha256
      )
        throw new Error("Snapshot SHA-256 verification failed");
      return { snapshot, data };
    } finally {
      await handle.close();
    }
  }
}
