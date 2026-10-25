/** Core-owned two-phase publication. Agent preparation NEVER grants send authority. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
const Provider = z.enum(["youtube", "tiktok", "x", "github", "notion"]);
const Privacy = z.enum(["public", "unlisted", "private", "self_only", "draft"]);
export type PublicationPrivacy = z.infer<typeof Privacy>;
export const PreparePublicationSchema = z
  .object({
    provider: Provider,
    accountId: z.string().min(1).max(256),
    title: z.string().max(256),
    description: z.string().max(20_000),
    mediaId: z.string().max(256).optional(),
    destination: z.string().max(512).optional(),
  })
  .strict();
export const ConfirmPublicationSchema = z
  .object({
    id: z.string().uuid(),
    confirmation: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    title: z.string().max(256),
    description: z.string().max(20_000),
    privacy: Privacy,
    comments: z.boolean().default(false),
    duet: z.boolean().default(false),
    stitch: z.boolean().default(false),
    commercial: z.boolean().default(false),
    ownBrand: z.boolean().default(false),
    brandedContent: z.boolean().default(false),
    termsAccepted: z.literal(true),
  })
  .strict();
export type PreparePublication = z.infer<typeof PreparePublicationSchema>;
export type PublicationFields = Omit<z.infer<typeof ConfirmPublicationSchema>, "id" | "confirmation">;
export type PublicationState =
  "pending_publication" | "queued" | "processing" | "published" | "draft_uploaded" | "failed";
export interface PublicationAccount {
  id: string;
  generation: string;
  handle: string;
  provider: z.infer<typeof Provider>;
  privacy: PublicationPrivacy[];
  restricted?: boolean;
  /** Trusted adapter-fetched recipient/destination and immutable media snapshot, not an unchecked live path. */
  destinationLabel: string;
  media?: { id: string; name: string; sha256: string; bytes: number };
}
export interface PublicationRecord {
  id: string;
  project: string;
  createdAt: number;
  state: PublicationState;
  request: PreparePublication;
  account: PublicationAccount;
  fields?: PublicationFields;
  resultId?: string;
  error?: "send_failed" | "delivery_unknown";
}
export interface PublicationHost {
  authorizePrepare(project: string, request: PreparePublication): Promise<PublicationAccount>;
  /** Must recheck account generation/entitlement and use the immutable snapshot. No generic URL or arbitrary headers. */
  send(
    record: Readonly<PublicationRecord>,
    signal: AbortSignal,
  ): Promise<{ state: "published" | "draft_uploaded"; id: string }>;
  persist(records: ReadonlyArray<PublicationRecord>): Promise<void>;
  audit(event: {
    operation: string;
    id: string;
    project: string;
    provider: string;
    state: PublicationState;
    error?: string;
  }): Promise<void>;
  now?(): number;
}
const AccountSnapshotSchema = z
  .object({
    id: z.string().min(1).max(256),
    generation: z.string().min(1).max(256),
    handle: z.string().min(1).max(256),
    provider: Provider,
    privacy: z.array(Privacy).min(1).max(5),
    restricted: z.boolean().optional(),
    destinationLabel: z.string().min(1).max(1024),
    media: z
      .object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const JournalEntrySchema = z
  .object({
    id: z.string().uuid(),
    project: z.string().min(1).max(4096),
    createdAt: z.number().int().nonnegative(),
    state: z.enum(["pending_publication", "queued", "processing", "published", "draft_uploaded", "failed"]),
    request: PreparePublicationSchema,
    account: AccountSnapshotSchema,
    fields: ConfirmPublicationSchema.omit({ id: true, confirmation: true }).optional(),
    resultId: z.string().min(1).max(512).optional(),
    error: z.enum(["send_failed", "delivery_unknown"]).optional(),
  })
  .strict();
const fail = (text: string): never => {
  throw new Error(text);
};
const clone = <T>(v: T): T => structuredClone(v);
export class PublicationService {
  private readonly records = new Map<string, PublicationRecord>();
  private readonly sessions = new WeakMap<object, Map<string, { proof: Buffer; expiresAt: number; binding: string }>>();
  private readonly key = randomBytes(32);
  private readonly active = new Map<string, AbortController>();
  private tail = Promise.resolve();
  constructor(private readonly host: PublicationHost) {}
  private now() {
    return (this.host.now ?? Date.now)();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private binding(r: PublicationRecord) {
    return createHash("sha256")
      .update(JSON.stringify([r.id, r.project, r.request, r.account]))
      .digest("hex");
  }
  private proof(nonce: string, binding: string) {
    return createHmac("sha256", this.key)
      .update(nonce + ":" + binding)
      .digest();
  }
  private async save() {
    await this.host.persist([...this.records.values()].map(clone));
  }
  private async audit(r: PublicationRecord, operation = "publication." + r.state) {
    await this.host.audit({
      operation,
      id: r.id,
      project: r.project,
      provider: r.request.provider,
      state: r.state,
      ...(r.error ? { error: r.error } : {}),
    });
  }
  async restore(records: ReadonlyArray<PublicationRecord>): Promise<void> {
    if (this.records.size) fail("Publication journal already initialized");
    const parsed = z.array(JournalEntrySchema).max(1000).parse(records);
    if (new Set(parsed.map((r) => r.id)).size !== parsed.length) fail("Duplicate publication journal ID");
    const interrupted: PublicationRecord[] = [];
    for (const entry of parsed) {
      const r: PublicationRecord = clone(entry);
      if (r.state === "processing" || r.state === "queued") {
        r.state = "failed";
        r.error = "delivery_unknown";
        interrupted.push(r);
      }
      this.records.set(r.id, r);
    }
    await this.save();
    for (const r of interrupted) await this.audit(r, "publication.interrupted");
  }
  async preparePublication(project: string, input: unknown): Promise<PublicationRecord> {
    const request = PreparePublicationSchema.parse(input);
    if (!project || project.length > 4096) fail("Invalid publication project");
    return this.serial(async () => {
      if (this.records.size >= 1000) fail("Publication journal capacity reached");
      const account = AccountSnapshotSchema.parse(await this.host.authorizePrepare(project, clone(request)));
      if (
        account.id !== request.accountId ||
        account.provider !== request.provider ||
        !account.generation ||
        !account.privacy.length
      )
        fail("Publication account is unavailable");
      const r: PublicationRecord = {
        id: randomUUID(),
        project,
        createdAt: this.now(),
        state: "pending_publication",
        request: clone(request),
        account: clone(account),
      };
      this.records.set(r.id, r);
      try {
        await this.save();
        await this.audit(r);
      } catch {
        this.records.delete(r.id);
        throw new Error("Publication preparation could not be recorded");
      }
      return clone(r);
    });
  }
  list(project?: string): PublicationRecord[] {
    return [...this.records.values()].filter((r) => !project || r.project === project).map(clone);
  }
  /** Called ONLY with the transport's authenticated owner connection object. It is never a JSON parameter. */
  openForOwner(id: string, owner: object): { publication: PublicationRecord; confirmation: string } {
    if (!owner || typeof owner !== "object") fail("Authenticated owner session required");
    const r = this.records.get(id) ?? fail("Unknown publication");
    if (r.state !== "pending_publication") fail("Publication is not pending");
    let session = this.sessions.get(owner);
    if (!session) {
      session = new Map();
      this.sessions.set(owner, session);
    }
    const nonce = randomBytes(32).toString("base64url"),
      binding = this.binding(r);
    session.set(id, { proof: this.proof(nonce, binding), expiresAt: this.now() + 180_000, binding });
    return { publication: clone(r), confirmation: nonce };
  }
  endOwnerSession(owner: object) {
    this.sessions.delete(owner);
  }
  async confirmPublication(owner: object, input: unknown): Promise<PublicationRecord> {
    // Privacy is required, no default; terms must be true. Unknown/account/media fields cannot be substituted.
    const fields = ConfirmPublicationSchema.parse(input);
    if (fields.commercial && !fields.ownBrand && !fields.brandedContent)
      fail("Commercial disclosure requires a selected brand category");
    if (!fields.commercial && (fields.ownBrand || fields.brandedContent))
      fail("Brand categories require commercial disclosure");
    const r = this.records.get(fields.id) ?? fail("Unknown publication"),
      session = this.sessions.get(owner),
      permit = session?.get(r.id);
    if (
      r.state !== "pending_publication" ||
      !permit ||
      permit.expiresAt <= this.now() ||
      permit.binding !== this.binding(r)
    )
      fail("Owner publication confirmation is missing, expired or stale");
    const validPermit = permit ?? fail("Owner publication confirmation is required");
    const proof = this.proof(fields.confirmation, validPermit.binding);
    if (!timingSafeEqual(proof, validPermit.proof)) fail("Invalid owner publication confirmation");
    if (!r.account.privacy.includes(fields.privacy)) fail("Privacy is not available for the verified recipient");
    if (r.request.provider !== "tiktok" && (fields.duet || fields.stitch))
      fail("Duet and stitch are TikTok-only settings");
    // Consume synchronously before ANY async persistence, authorization or external I/O. No replay, even on failure.
    session!.delete(r.id);
    r.state = "queued";
    const { id: _, confirmation: __, ...payload } = fields;
    void _;
    void __;
    r.fields = clone(payload);
    const controller = new AbortController();
    this.active.set(r.id, controller);
    let deliveryStarted = false;
    try {
      await this.serial(async () => {
        await this.save();
        await this.audit(r);
      });
      const current = AccountSnapshotSchema.parse(await this.host.authorizePrepare(r.project, clone(r.request)));
      if (
        current.generation !== r.account.generation ||
        current.id !== r.account.id ||
        JSON.stringify(current) !== JSON.stringify(r.account)
      )
        fail("Publication recipient or account changed; prepare again");
      if (controller.signal.aborted) fail("Publication cancelled");
      r.state = "processing";
      await this.serial(async () => {
        await this.save();
        await this.audit(r);
      });
      if (controller.signal.aborted) fail("Publication cancelled");
      deliveryStarted = true;
      const result = await this.host.send(clone(r), controller.signal);
      if (!["published", "draft_uploaded"].includes(result.state) || !result.id || result.id.length > 512)
        fail("Invalid publication result");
      if (fields.privacy === "draft" && result.state !== "draft_uploaded")
        fail("Provider did not confirm draft delivery");
      r.state = result.state;
      r.resultId = result.id;
      await this.serial(async () => {
        await this.save();
        await this.audit(r);
      });
    } catch {
      r.state = "failed";
      r.error = deliveryStarted ? "delivery_unknown" : "send_failed";
      await this.serial(async () => {
        await this.save();
        await this.audit(r);
      });
    } finally {
      this.active.delete(r.id);
    }
    return clone(r);
  }
  /** Account revocation / global kill cannot leave an authorized background publication running. */
  abortAccount(accountId?: string) {
    for (const [id, controller] of this.active) {
      if (!accountId || this.records.get(id)?.account.id === accountId) controller.abort();
    }
  }
}
