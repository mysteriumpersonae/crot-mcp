/** Service-owned account lifecycle; tokens never enter metadata, renderer records or the product vault. */
import { z } from "zod";
import { SocialProviderSchema } from "./account-secrets.js";
import { randomUUID } from "node:crypto";
import { AccountSecrets, type SocialProvider } from "./account-secrets.js";
import { startOAuthLoopback, type OAuthFlow } from "./oauth-loopback.js";
export type SocialAccountState = "disconnected" | "connected" | "reauth_required" | "restricted";
export interface AccountProfile {
  id: string;
  handle: string;
  name: string;
  avatar?: string;
  restricted?: boolean;
  restriction?: string;
}
export interface SocialAccount {
  provider: SocialProvider;
  clientId?: string;
  id?: string;
  handle?: string;
  name?: string;
  avatar?: string;
  state: SocialAccountState;
  generation: string;
  expiresAt?: number;
  checkedAt?: number;
  restriction?: string;
  revocation?: "requested" | "failed";
  cleanup?: "complete" | "failed";
}
export interface OAuthTokens {
  access: string;
  refresh?: string;
  expiresIn?: number;
}
export interface ProviderClient {
  clientId: string;
  clientSecret?: string;
}
export interface OAuthAccountAdapter {
  readonly provider: SocialProvider;
  readonly authorizationEndpoint: string;
  readonly scopes: readonly string[];
  readonly scopeSeparator?: " " | ",";
  readonly pkce: boolean;
  readonly challengeEncoding?: "base64url" | "hex";
  readonly clientParameter?: "client_id" | "client_key";
  readonly authorizationExtra?: Readonly<Record<string, string>>;
  exchange(
    client: ProviderClient,
    input: { code: string; verifier: string; redirectUri: string; signal: AbortSignal },
  ): Promise<OAuthTokens>;
  refresh?(client: ProviderClient, refresh: string, signal: AbortSignal): Promise<OAuthTokens>;
  profile(access: string, signal: AbortSignal): Promise<AccountProfile>;
  revoke(client: ProviderClient, token: { access?: string; refresh?: string }, signal: AbortSignal): Promise<void>;
}
export interface SocialAccountHost {
  secrets(): Promise<AccountSecrets>;
  persist(accounts: readonly SocialAccount[]): Promise<void>;
  audit(event: {
    operation: string;
    provider: SocialProvider;
    state: SocialAccountState;
    generation: string;
    revocation?: string;
    cleanup?: string;
  }): Promise<void>;
  openBrowser(url: string): Promise<void>;
  now?(): number;
  /** Injection exists only in the trusted service composition, never owner/agent JSON schemas. */
  loopbackFixtures?: boolean;
}
const AccountMetadataSchema = z
  .object({
    provider: SocialProviderSchema,
    clientId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\r\n\0]+$/)
      .optional(),
    id: z.string().min(1).max(300).optional(),
    handle: z.string().min(1).max(256).optional(),
    name: z.string().max(512).optional(),
    avatar: z
      .string()
      .url()
      .max(4096)
      .refine((v) => new URL(v).protocol === "https:")
      .optional(),
    state: z.enum(["disconnected", "connected", "reauth_required", "restricted"]),
    generation: z.string().uuid(),
    expiresAt: z.number().safe().nonnegative().optional(),
    checkedAt: z.number().safe().nonnegative().optional(),
    restriction: z.string().max(256).optional(),
    revocation: z.enum(["requested", "failed"]).optional(),
    cleanup: z.enum(["complete", "failed"]).optional(),
  })
  .strict();
export class AccountAuthorizationError extends Error {}
export class SocialAccountService {
  private readonly accounts = new Map<SocialProvider, SocialAccount>();
  private readonly flows = new Map<SocialProvider, OAuthFlow>();
  private readonly active = new Map<SocialProvider, Set<AbortController>>();
  private readonly queues = new Map<SocialProvider, Promise<unknown>>();
  private persistTail = Promise.resolve();
  constructor(
    private readonly host: SocialAccountHost,
    private readonly adapters: ReadonlyMap<SocialProvider, OAuthAccountAdapter>,
  ) {
    for (const provider of ["youtube", "tiktok", "x", "github", "notion"] as const)
      this.accounts.set(provider, { provider, state: "disconnected", generation: randomUUID() });
  }
  private now() {
    return (this.host.now ?? Date.now)();
  }
  private serial<T>(provider: SocialProvider, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(provider) ?? Promise.resolve()).then(work, work);
    this.queues.set(
      provider,
      next.catch(() => undefined),
    );
    return next;
  }
  private account(provider: SocialProvider) {
    const value = this.accounts.get(provider);
    if (!value) throw new Error("Unknown social account provider");
    return value;
  }
  private adapter(provider: SocialProvider) {
    const value = this.adapters.get(provider);
    if (!value) throw new Error("OAuth provider is not configured");
    return value;
  }
  private async save() {
    const records = this.list();
    const next = this.persistTail.then(() => this.host.persist(records));
    this.persistTail = next.catch(() => undefined);
    await next;
  }
  private async audit(a: SocialAccount, operation: string) {
    await this.host.audit({
      operation,
      provider: a.provider,
      state: a.state,
      generation: a.generation,
      ...(a.revocation ? { revocation: a.revocation } : {}),
      ...(a.cleanup ? { cleanup: a.cleanup } : {}),
    });
  }
  list(): SocialAccount[] {
    return structuredClone([...this.accounts.values()]);
  }
  /** Only bounded non-secret metadata is restored; credentials are always read from the OS on use. */
  restore(input: unknown): void {
    const records = z.array(AccountMetadataSchema).length(5).parse(input);
    if (new Set(records.map((r) => r.provider)).size !== 5) throw new Error("Duplicate account metadata");
    if (this.flows.size || this.queues.size) throw new Error("Cannot restore active account service");
    for (const row of records) {
      if (
        (row.state === "connected" || (row.state === "restricted" && row.cleanup !== "failed")) &&
        (!row.id || !row.handle || !row.clientId)
      )
        throw new Error("Incomplete account identity");
      if (row.cleanup === "failed" && row.state !== "restricted") throw new Error("Invalid cleanup state");
    }
    for (const row of records) this.accounts.set(row.provider, structuredClone(row));
  }
  private async requireReauthorization(a: SocialAccount, secrets: AccountSecrets, operation: string): Promise<void> {
    a.state = "reauth_required";
    try {
      await secrets.clear(a.provider, true);
    } catch {
      a.state = "restricted";
      a.cleanup = "failed";
      a.restriction = "secret_cleanup_failed";
    }
    // Even failed OS cleanup must persist a state that cannot issue another credential lease.
    await this.save();
    await this.audit(a, operation);
  }
  pendingProviders(): SocialProvider[] {
    return [...this.flows.keys()];
  }
  async check(provider: SocialProvider): Promise<void> {
    await this.withCredential(provider, async (access, signal, lease) => {
      const profile = await this.adapter(provider).profile(access, signal),
        a = this.account(provider);
      this.checkGeneration(a, lease.generation, signal);
      const next = AccountMetadataSchema.parse({
        ...a,
        id: provider + ":" + profile.id,
        handle: profile.handle,
        name: profile.name,
        avatar: profile.avatar,
        state: profile.restricted ? "restricted" : "connected",
        restriction: profile.restriction,
        checkedAt: this.now(),
      });
      if (!profile.id || !profile.handle || profile.handle === "@") throw new Error("Provider identity unavailable");
      Object.assign(a, next);
      await this.save();
      await this.audit(a, "account.checked");
    });
  }
  async configure(provider: SocialProvider, clientId: string, clientSecret?: string) {
    return this.serial(provider, async () => {
      const a = this.account(provider);
      if (!clientId || clientId.length > 512 || /[\r\n\0]/.test(clientId)) throw new Error("Invalid OAuth client ID");
      if (a.state === "connected" || a.state === "restricted" || this.flows.has(provider))
        throw new Error("Disconnect the account before changing OAuth app configuration");
      const secrets = await this.host.secrets();
      if (clientSecret !== undefined) await secrets.write(provider, "clientSecret", clientSecret);
      a.clientId = clientId;
      await this.save();
      await this.audit(a, "account.configured");
    });
  }
  private controller(provider: SocialProvider) {
    const controller = new AbortController();
    let set = this.active.get(provider);
    if (!set) {
      set = new Set();
      this.active.set(provider, set);
    }
    set.add(controller);
    return { controller, done: () => set!.delete(controller) };
  }
  private checkGeneration(a: SocialAccount, generation: string, signal: AbortSignal) {
    if (a.generation !== generation || signal.aborted) throw new Error("Account session was revoked");
  }
  private async storeTokens(
    a: SocialAccount,
    generation: string,
    tokens: OAuthTokens,
    secrets: AccountSecrets,
    signal: AbortSignal,
  ) {
    this.checkGeneration(a, generation, signal);
    if (
      tokens.expiresIn !== undefined &&
      (!Number.isSafeInteger(tokens.expiresIn) || tokens.expiresIn <= 0 || tokens.expiresIn > 366 * 86400)
    )
      throw new Error("Invalid OAuth expiry");
    try {
      await secrets.write(a.provider, "access", tokens.access);
      this.checkGeneration(a, generation, signal);
      if (tokens.refresh) await secrets.write(a.provider, "refresh", tokens.refresh);
      this.checkGeneration(a, generation, signal);
    } catch {
      await secrets.clear(a.provider, true);
      throw new Error("OAuth credentials could not be committed to system storage");
    }
    a.expiresAt = tokens.expiresIn === undefined ? undefined : this.now() + tokens.expiresIn * 1000;
  }
  async connect(provider: SocialProvider): Promise<{ flowId: string; authorizationUrl: string }> {
    return this.serial(provider, async () => {
      const a = this.account(provider),
        adapter = this.adapter(provider);
      if (!adapter.pkce)
        throw new Error(
          "This provider requires a PKCE-capable hosted broker; direct OAuth is disabled, not silently downgraded",
        );
      if (!a.clientId) throw new Error("Configure the OAuth application first");
      if (this.flows.has(provider)) throw new Error("Account authorization is already pending");
      if (a.state === "connected" || a.state === "restricted")
        throw new Error("Disconnect the existing account before replacing it");
      const secrets = await this.host.secrets(),
        client = { clientId: a.clientId, clientSecret: await secrets.read(provider, "clientSecret") };
      await secrets.clear(provider, true);
      a.generation = randomUUID();
      a.state = "reauth_required";
      delete a.cleanup;
      delete a.revocation;
      await this.save();
      const generation = a.generation;
      let authorizationUrl = "";
      const flow = await startOAuthLoopback({
        authorizationEndpoint: adapter.authorizationEndpoint,
        clientId: a.clientId,
        scopes: adapter.scopes,
        scopeSeparator: adapter.scopeSeparator,
        challengeEncoding: adapter.challengeEncoding,
        clientParameter: adapter.clientParameter,
        extra: adapter.authorizationExtra,
        allowLoopbackFixture: this.host.loopbackFixtures,
        openBrowser: async (url) => {
          authorizationUrl = url;
          await this.host.openBrowser(url);
        },
        exchange: (input) =>
          this.serial(provider, async () => {
            this.checkGeneration(a, generation, input.signal);
            const tokens = await adapter.exchange(client, input);
            this.checkGeneration(a, generation, input.signal);
            const profile = await adapter.profile(tokens.access, input.signal);
            this.checkGeneration(a, generation, input.signal);
            if (
              !profile.id ||
              profile.id.length > 256 ||
              !profile.handle ||
              profile.handle.length > 256 ||
              profile.name.length > 512
            )
              throw new Error("Invalid provider profile");
            await this.storeTokens(a, generation, tokens, secrets, input.signal);
            Object.assign(a, {
              id: provider + ":" + profile.id,
              handle: profile.handle,
              name: profile.name,
              avatar: profile.avatar,
              state: profile.restricted ? "restricted" : "connected",
              restriction: profile.restriction,
              checkedAt: this.now(),
            });
            await this.save();
            await this.audit(a, "account.connected");
          }),
      });
      this.flows.set(provider, flow);
      void flow.completion
        .catch(() =>
          this.serial(provider, async () => {
            if (a.generation === generation) {
              await this.requireReauthorization(a, secrets, "account.authorization_failed");
            }
          }),
        )
        .finally(() => {
          if (this.flows.get(provider) === flow) this.flows.delete(provider);
        })
        .catch(() => undefined); // State stays fail-closed even if metadata/audit persistence fails.

      return { flowId: flow.id, authorizationUrl };
    });
  }
  /** Runtime callers receive only a callback-scoped token, never a serializable credential result. */
  async withCredential<T>(
    provider: SocialProvider,
    work: (access: string, signal: AbortSignal, account: Readonly<SocialAccount>) => Promise<T>,
  ): Promise<T> {
    return this.serial(provider, async () => {
      const a = this.account(provider);
      if (
        (a.state !== "connected" && a.state !== "restricted") ||
        (a.state === "restricted" && a.restriction !== "tiktok_private_or_draft_only")
      )
        throw new AccountAuthorizationError("Account requires authorization");
      const adapter = this.adapter(provider),
        secrets = await this.host.secrets(),
        generation = a.generation,
        { controller, done } = this.controller(provider);
      try {
        let access = await secrets.read(provider, "access");
        this.checkGeneration(a, generation, controller.signal);
        if (!access) throw new AccountAuthorizationError("Account access token is unavailable");
        if (a.expiresAt !== undefined && a.expiresAt <= this.now() + 30_000) {
          const refresh = await secrets.read(provider, "refresh");
          if (!refresh || !adapter.refresh) throw new AccountAuthorizationError("Account requires authorization");
          const tokens = await adapter.refresh(
            { clientId: a.clientId!, clientSecret: await secrets.read(provider, "clientSecret") },
            refresh,
            controller.signal,
          );
          await this.storeTokens(a, generation, tokens, secrets, controller.signal);
          access = tokens.access;
          await this.save();
        }
        this.checkGeneration(a, generation, controller.signal);
        return await work(access, controller.signal, structuredClone(a));
      } catch (error) {
        if (error instanceof AccountAuthorizationError && a.generation === generation) {
          await this.requireReauthorization(a, secrets, "account.reauth_required");
        }
        throw error;
      } finally {
        done();
      }
    });
  }
  async disconnect(provider: SocialProvider): Promise<SocialAccount> {
    const a = this.account(provider);
    a.generation = randomUUID(); // Invalidate leases synchronously, before waiting for a provider/store operation.
    a.state = "disconnected";
    delete a.expiresAt;
    for (const controller of this.active.get(provider) ?? []) controller.abort();
    const flow = this.flows.get(provider);
    if (flow) {
      this.flows.delete(provider);
      await flow.cancel();
    }
    return this.serial(provider, async () => {
      a.state = "disconnected";
      delete a.expiresAt;
      // Metadata failure must not prevent revocation/OS-secret cleanup.
      let secrets: AccountSecrets;
      try {
        secrets = await this.host.secrets();
      } catch {
        a.state = "restricted";
        a.cleanup = "failed";
        a.restriction = "secret_store_unavailable";
        await this.save();
        await this.audit(a, "account.disconnected");
        throw new Error("Account disabled but system secret store is unavailable; retry disconnect");
      }
      let revokeFailed = false;
      try {
        const access = await secrets.read(provider, "access"),
          refresh = await secrets.read(provider, "refresh");
        if (access || refresh) {
          const client = { clientId: a.clientId!, clientSecret: await secrets.read(provider, "clientSecret") };
          await this.adapter(provider).revoke(client, { access, refresh }, AbortSignal.timeout(15_000));
        }
      } catch {
        revokeFailed = true;
      } finally {
        try {
          await secrets.clear(provider);
          a.cleanup = "complete";
        } catch {
          a.cleanup = "failed";
          a.state = "restricted";
          a.restriction = "secret_cleanup_failed";
        }
        a.revocation = revokeFailed ? "failed" : "requested";
        await this.save();
        await this.audit(a, "account.disconnected");
      }
      if (a.cleanup !== "complete")
        throw new Error("Account disabled but system secret cleanup failed; retry disconnect");
      return structuredClone(a);
    });
  }
  async cancel(provider: SocialProvider): Promise<void> {
    const flow = this.flows.get(provider);
    if (!flow) return;
    await flow.cancel();
    await flow.completion.catch(() => undefined);
    await this.serial(provider, async () => undefined);
  }
  async close() {
    for (const provider of this.accounts.keys()) {
      for (const c of this.active.get(provider) ?? []) c.abort();
      await this.flows.get(provider)?.cancel();
    }
    await Promise.all([...this.queues.values()]);
    await this.persistTail;
  }
}
