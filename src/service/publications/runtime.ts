import { accountDiagnostics } from "../social/diagnostics.js";
/** Trusted service composition. No credentials, staging paths or send authority appear in agent JSON. */
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { CrotCore } from "../../core/crot-core.js";
import type { AuthContext } from "../../core/auth/principal.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { PublicationRequestSchema, PublicationPreviewSchema } from "../../core/publications/schemas.js";
import { PublicationMedia, type MediaSnapshot } from "../../core/publications/media.js";
import {
  PublicationService,
  type PublicationHost,
  type PreparePublication,
  type PublicationAccount,
} from "../../core/publications/service.js";
import { openTransferRead, verifyTransferIdentity } from "../../native-host/browser-files.js";
import { writePrivateFileAtomic } from "../secrets/backends.js";
import type { SocialAccountRuntime } from "../social/runtime.js";
import { productionPublisher, type PlatformPublisher } from "./platforms.js";
export { PublicationRequestSchema, PublicationPreviewSchema } from "../../core/publications/schemas.js";
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
  private readonly endedOwners = new WeakSet<object>();
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
    // Native descriptor identity checks require canonical names (not /tmp aliases on macOS).
    host = { ...host, stateDir: await realpath(host.stateDir) };
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
  private owner(owner: object, requireRunning = false) {
    if ((requireRunning && this.closed) || !owner || typeof owner !== "object" || this.endedOwners.has(owner))
      throw new Error("Authenticated owner connection required");
  }
  list(owner: object) {
    this.owner(owner);
    // Compact bounded response; full descriptions and snapshots are only fetched individually.
    const candidates = this.engine
      .list(this.host.project())
      .slice(-100)
      .map((r) => ({
        id: r.id,
        state: r.state,
        provider: r.request.provider,
        handle: r.account.handle,
        createdAt: r.createdAt,
        resultId: r.resultId,
        error: r.error,
      }));
    const publications: typeof candidates = [];
    let bytes = 256;
    // A row count alone does not bound escaped handles/result IDs below the 64-KiB wire cap.
    for (const row of candidates.reverse()) {
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (bytes + size > 48_000) break;
      publications.unshift(row);
      bytes += size;
    }
    return { ok: true, publications, truncated: publications.length < candidates.length };
  }

  openForOwner(owner: object, id: string) {
    this.owner(owner, true);
    if (!this.engine.list(this.host.project()).some((r) => r.id === id))
      throw new Error("Publication does not belong to the active project");
    const opened = this.engine.openForOwner(id, owner);
    const account = this.host.accounts
      .list()
      .accounts.find(
        (account) =>
          account.id === opened.publication.account.id && account.generation === opened.publication.account.generation,
      );
    return { ok: true, ...opened, ...(account ? { diagnostics: accountDiagnostics(account) } : {}) };
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
    this.owner(owner, true);
    const fields = this.engine.assertConfirmation(owner, input);
    if (!this.engine.list(this.host.project()).some((r) => r.id === fields.id))
      throw new Error("Publication project changed");
    // Start in this same JS turn: engine consumes the permit synchronously, before its first await.
    const job = this.engine.confirmPublication(owner, input);
    this.jobs.add(job);
    void job.catch(() => undefined).finally(() => this.jobs.delete(job));
    return { ok: true, id: fields.id, state: "queued" };
  }
  async cancel(owner: object, id: string) {
    this.owner(owner);
    if (!this.engine.list(this.host.project()).some((r) => r.id === id))
      throw new Error("Publication does not belong to the active project");
    return { ok: true, ...(await this.engine.cancelPublication(owner, id)) };
  }
  endOwnerSession(owner: object) {
    this.endedOwners.add(owner);
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
