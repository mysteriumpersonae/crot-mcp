/** Trusted service composition. No credentials, staging paths or send authority appear in agent JSON. */
import path from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import type { CrotCore } from "../../core/crot-core.js";
import type { AuthContext } from "../../core/auth/principal.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { ArtifactPathSchema } from "../../core/platform/workspace-artifacts.js";
import { PublicationMedia, type MediaSnapshot } from "../../core/publications/media.js";
import {
  PublicationService,
  PreparePublicationSchema,
  type PublicationHost,
  type PreparePublication,
  type PublicationAccount,
} from "../../core/publications/service.js";
import { openTransferRead, verifyTransferIdentity } from "../../native-host/browser-files.js";
import { writePrivateFileAtomic } from "../secrets/backends.js";
import type { SocialAccountRuntime } from "../social/runtime.js";
import { productionPublisher, type PlatformPublisher } from "./platforms.js";
export const PublicationRequestSchema = PreparePublicationSchema.omit({ mediaId: true, destination: true })
  .extend({
    provider: z.enum(["youtube", "tiktok", "x"]),
    mediaPath: ArtifactPathSchema.optional(),
  })
  .strict();
export const PublicationPreviewSchema = z
  .object({ id: z.string().uuid(), offset: z.number().int().min(0), length: z.number().int().min(1).max(24_576) })
  .strict();
export interface PublicationRuntimeHost {
  stateDir: string;
  privateFiles: PrivateFileProtection;
  core(): CrotCore;
  project(): string;
  accounts: Pick<SocialAccountRuntime, "list" | "usePublicationCredential">;
  /** Mandatory fresh entitlement AND managed-channel anti-bypass authorization. No optional/default allow. */
  authorizePublication(): Promise<void>;
  audit: PublicationHost["audit"];
  /** In-process HTTP fixture composition only. Never RPC/CLI configuration. */
  publisher?: PlatformPublisher;
}
export class PublicationRuntime {
  private readonly engine: PublicationService;
  private readonly jobs = new Set<Promise<unknown>>();
  private closed = false;
  private readonly previews = new Map<string, { snapshot: MediaSnapshot; data: Buffer }>();
  private preparing = 0;
  private prepareTail = Promise.resolve();
  private constructor(
    private readonly host: PublicationRuntimeHost,
    private readonly media: PublicationMedia,
  ) {
    this.engine = new PublicationService({
      authorizePrepare: (project, request) => this.authorize(project, request),
      persist: (records) =>
        writePrivateFileAtomic(
          path.join(host.stateDir, "publications.json"),
          JSON.stringify(records),
          host.privateFiles,
        ),
      audit: host.audit,
      send: async (record, signal) => {
        await this.requireAvailable(record.project);
        const snapshot = record.request.mediaId
          ? await this.media.verified(record.request.mediaId, record.project)
          : undefined;
        if (
          JSON.stringify(record.account.media) !==
          JSON.stringify(snapshot ? this.mediaBinding(snapshot.snapshot) : undefined)
        )
          throw new Error("Publication media binding changed");
        return this.host.accounts.usePublicationCredential(
          record.request.provider,
          record.account.id,
          record.account.generation,
          (access, accountSignal) =>
            (host.publisher ?? productionPublisher())({
              record,
              media: snapshot,
              access,
              signal: AbortSignal.any([signal, accountSignal]),
            }),
        );
      },
    });
  }
  static async open(host: PublicationRuntimeHost): Promise<PublicationRuntime> {
    const runtime = new PublicationRuntime(
      host,
      await PublicationMedia.open(path.join(host.stateDir, "publication-media"), host.privateFiles),
    );
    const journal = path.join(host.stateDir, "publications.json");
    const entry = await lstat(journal).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1))
      throw new Error("Invalid publication journal");
    // Native Windows open intentionally reports generic safe errors, not Node ENOENT.
    // Missing journal is determined with lstat; disappearance after this check fails closed.
    const handle = entry ? await openTransferRead(journal) : undefined;
    if (handle) {
      let raw: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 * 1024)
          throw new Error("Invalid publication journal");
        raw = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < raw.length) {
          const chunk = await handle.read(raw, offset, raw.length - offset, offset);
          if (!chunk.bytesRead) throw new Error("Publication journal truncated");
          offset += chunk.bytesRead;
        }
        await verifyTransferIdentity(path.join(host.stateDir, "publications.json"), before);
        const after = await handle.stat();
        if (after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs)
          throw new Error("Publication journal changed");
      } finally {
        await handle.close();
      }
      await runtime.engine.restore(JSON.parse(raw.toString("utf8")));
    }
    return runtime;
  }
  private async requireAvailable(project: string) {
    if (this.closed || project !== this.host.project()) throw new Error("Publication project is no longer active");
    await this.host.authorizePublication();
    if (this.closed || project !== this.host.project()) throw new Error("Publication project changed");
  }
  private mediaBinding(snapshot: MediaSnapshot) {
    return { id: snapshot.id, name: snapshot.name, sha256: snapshot.sha256, bytes: snapshot.bytes };
  }
  private async authorize(project: string, request: PreparePublication): Promise<PublicationAccount> {
    await this.requireAvailable(project);
    const account = this.host.accounts
      .list()
      .accounts.find((a) => a.provider === request.provider && a.id === request.accountId);
    if (
      !account?.id ||
      !account.handle ||
      (account.state !== "connected" &&
        !(
          account.provider === "tiktok" &&
          account.state === "restricted" &&
          account.restriction === "tiktok_private_or_draft_only"
        ))
    )
      throw new Error("Publication account unavailable or restricted");
    if (!["youtube", "tiktok", "x"].includes(account.provider)) throw new Error("Publication provider unsupported");
    if (account.provider !== "x" && !request.mediaId)
      throw new Error("Video publication requires an immutable media snapshot");
    return {
      id: account.id,
      generation: account.generation,
      handle: account.handle,
      provider: account.provider,
      privacy:
        account.provider === "youtube"
          ? ["public", "unlisted", "private"]
          : account.provider === "tiktok"
            ? ["draft"]
            : ["public"],
      restricted: account.state === "restricted",
      destinationLabel: account.handle,
      ...(request.mediaId ? { media: this.mediaBinding(this.media.get(request.mediaId, project)) } : {}),
    };
  }
  async prepare(context: AuthContext, input: unknown) {
    if (this.closed || this.preparing >= 32)
      return Promise.reject(new Error("Publication preparation unavailable or queue full"));
    const parsed = PublicationRequestSchema.parse(input);
    this.preparing++;
    const work = this.prepareTail.then(() => this.prepareRequest(context, parsed));
    this.prepareTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work.finally(() => {
      this.preparing--;
    });
  }
  private async prepareRequest(context: AuthContext, input: unknown) {
    const parsed = PublicationRequestSchema.parse(input),
      project = this.host.project();
    await this.requireAvailable(project);
    // Validate recipient before allocating private storage. A temporary media ID is never accepted from JSON.
    const recipient = this.host.accounts
      .list()
      .accounts.find((a) => a.provider === parsed.provider && a.id === parsed.accountId);
    if (!recipient || !["connected", "restricted"].includes(recipient.state))
      throw new Error("Publication account unavailable");
    const { mediaPath, ...request } = parsed;
    let mediaId: string | undefined;
    if (mediaPath) {
      const artifact = await this.host.core().filesystem.capturePublicationMedia(context, mediaPath);
      await this.requireAvailable(project);
      mediaId = (await this.media.capture(project, mediaPath, artifact.data)).id;
    }
    try {
      return await this.engine.preparePublication(project, { ...request, ...(mediaId ? { mediaId } : {}) });
    } catch (error) {
      if (mediaId) await this.media.discard(mediaId, project).catch(() => undefined);
      throw error;
    }
  }
  private owner(owner: object) {
    if (this.closed || !owner || typeof owner !== "object") throw new Error("Authenticated owner connection required");
  }
  list(owner: object) {
    this.owner(owner);
    // Compact bounded response; full descriptions and snapshots are only fetched individually.
    return {
      ok: true,
      publications: this.engine
        .list(this.host.project())
        .map((r) => ({
          id: r.id,
          state: r.state,
          provider: r.request.provider,
          handle: r.account.handle,
          createdAt: r.createdAt,
          resultId: r.resultId,
          error: r.error,
        }))
        .slice(-100),
    };
  }
  openForOwner(owner: object, id: string) {
    this.owner(owner);
    if (!this.engine.list(this.host.project()).some((r) => r.id === id))
      throw new Error("Publication does not belong to the active project");
    return { ok: true, ...this.engine.openForOwner(id, owner) };
  }
  async preview(owner: object, input: unknown) {
    this.owner(owner);
    const args = PublicationPreviewSchema.parse(input),
      project = this.host.project();
    const record = this.engine.list(project).find((r) => r.id === args.id);
    if (!record?.request.mediaId) throw new Error("Publication media unavailable");
    let cached = this.previews.get(record.request.mediaId);
    if (!cached) {
      cached = await this.media.verified(record.request.mediaId, project);
      this.owner(owner);
      if (project !== this.host.project()) throw new Error("Publication project changed during preview");
      if (JSON.stringify(record.account.media) !== JSON.stringify(this.mediaBinding(cached.snapshot)))
        throw new Error("Preview media binding changed");
      // Bound retained bytes to two verified snapshots (128 MiB); no quadratic rehash for 24-KiB RPC chunks.
      if (this.previews.size >= 2) this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(record.request.mediaId, cached);
    }
    const { data, snapshot } = cached;
    if (args.offset >= data.length) throw new Error("Invalid preview offset");
    return {
      ok: true,
      mime: snapshot.mime,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      offset: args.offset,
      data: data.subarray(args.offset, args.offset + args.length).toString("base64"),
    };
  }
  confirm(owner: object, input: unknown) {
    this.owner(owner);
    const fields = this.engine.assertConfirmation(owner, input);
    if (!this.engine.list(this.host.project()).some((r) => r.id === fields.id))
      throw new Error("Publication project changed");
    // Start in this same JS turn: engine consumes the permit synchronously, before its first await.
    const job = this.engine.confirmPublication(owner, input);
    this.jobs.add(job);
    void job.catch(() => undefined).finally(() => this.jobs.delete(job));
    return { ok: true, id: fields.id, state: "queued" };
  }
  endOwnerSession(owner: object) {
    this.engine.endOwnerSession(owner);
  }
  abortAccount(id?: string) {
    this.engine.abortAccount(id);
  }
  async close() {
    this.closed = true;
    this.engine.abortAccount();
    this.previews.clear();
    await this.prepareTail;
    await Promise.allSettled([...this.jobs]);
  }
}
