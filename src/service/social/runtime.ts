/** Service composition of account metadata + OS secrets. No credential result is serializable over owner RPC. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { writePrivateFileAtomic } from "../secrets/backends.js";
import { openAccountSecrets, type AccountSecrets, type SocialProvider } from "./account-secrets.js";
import { SocialAccountService, type SocialAccountHost, type OAuthAccountAdapter } from "./accounts.js";
import { productionOAuthAdapters } from "./provider-http.js";
export interface SocialRuntimeHost {
  stateDir: string;
  privateFiles: PrivateFileProtection;
  audit: SocialAccountHost["audit"];
  /** Trusted service fixture only. Never configuration/RPC data. */
  secrets?: () => Promise<AccountSecrets>;
  adapters?: ReadonlyMap<SocialProvider, OAuthAccountAdapter>;
  loopbackFixtures?: boolean;
}
export class SocialAccountRuntime {
  private readonly accounts: SocialAccountService;
  private constructor(host: SocialRuntimeHost) {
    let secrets: Promise<AccountSecrets> | undefined;
    this.accounts = new SocialAccountService(
      {
        secrets: () =>
          (secrets ??= (host.secrets ? host.secrets() : openAccountSecrets(host.stateDir, host.privateFiles)).catch(
            (error: unknown) => {
              secrets = undefined;
              throw error;
            },
          )),
        persist: (rows) =>
          writePrivateFileAtomic(
            path.join(host.stateDir, "social-accounts.json"),
            JSON.stringify(rows) + "\n",
            host.privateFiles,
          ),
        audit: host.audit,
        // The authenticated Electron owner receives only the generated authorization URL;
        // main independently validates its fixed endpoint and opens the SYSTEM browser.
        openBrowser: async () => undefined,
        loopbackFixtures: host.loopbackFixtures,
      },
      host.adapters ?? productionOAuthAdapters(),
    );
  }
  static async open(host: SocialRuntimeHost): Promise<SocialAccountRuntime> {
    const runtime = new SocialAccountRuntime(host);
    let raw: string | undefined;
    try {
      raw = await readFile(path.join(host.stateDir, "social-accounts.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Account metadata unavailable");
    }
    if (raw !== undefined) {
      if (Buffer.byteLength(raw) > 65536) throw new Error("Account metadata exceeds limit");
      runtime.accounts.restore(JSON.parse(raw));
    }
    return runtime;
  }
  list() {
    return { ok: true, accounts: this.accounts.list(), pending: this.accounts.pendingProviders() };
  }
  async configure(provider: SocialProvider, clientId: string, clientSecret?: string) {
    if (provider === "notion" && (clientId !== "crot-desktop" || clientSecret !== undefined))
      throw new Error("Notion uses the registered CROT broker client");
    await this.accounts.configure(provider, clientId, clientSecret);
    return this.list();
  }
  async connect(provider: SocialProvider) {
    return { ok: true, ...(await this.accounts.connect(provider)) };
  }
  async check(provider: SocialProvider) {
    await this.accounts.check(provider);
    return this.list();
  }
  async cancel(provider: SocialProvider) {
    await this.accounts.cancel(provider);
    return this.list();
  }
  async disconnect(provider: SocialProvider) {
    await this.accounts.disconnect(provider);
    return this.list();
  }
  /** Trusted in-process publisher only. This callback/credential is never an owner RPC result. */
  async usePublicationCredential<T>(
    provider: SocialProvider,
    accountId: string,
    generation: string,
    work: (access: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.accounts.withCredential(provider, async (access, signal, account) => {
      if (account.id !== accountId || account.generation !== generation)
        throw new Error("Publication account grant changed");
      return work(access, signal);
    });
  }
  async close() {
    await this.accounts.close();
  }
}
