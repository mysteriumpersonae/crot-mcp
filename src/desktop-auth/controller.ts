/** Fixed main-process API. No URL, database path, code-delivery policy or profile accepted from renderer. */
import { DesktopAuth, AuthError, type AuthResult } from "./store.js";
import { beginOAuth } from "./oauth.js";
import type { AuthEnvironment } from "./config.js";
export class DesktopAuthController {
  private flow?: Awaited<ReturnType<typeof beginOAuth>>;
  private oauthError?: string;
  private busy = false;
  private generation = 0;
  constructor(
    private auth: DesktopAuth,
    private env: AuthEnvironment,
    private browser: (url: string) => Promise<void>,
  ) {}
  cancel() {
    this.generation++;
    this.flow?.cancel();
    this.flow = undefined;
  }
  async call(method: unknown, input: unknown): Promise<AuthResult> {
    if (typeof method !== "string" || !input || typeof input !== "object" || Array.isArray(input))
      return { ok: false, error: "INVALID_REQUEST" };
    const p = input as Record<string, unknown>;
    const keys: Record<string, string[]> = {
      register: ["login", "email", "password"],
      login: ["identifier", "password"],
      verify: ["challengeId", "code"],
      resend: ["challengeId"],
      oauth: ["provider"],
      status: [],
      cancel: [],
      logout: [],
    };
    if (
      !Object.hasOwn(keys, method) ||
      Object.keys(p).some((k) => !keys[method]!.includes(k)) ||
      Object.values(p).some((v) => typeof v !== "string" || v.length > 512)
    )
      return { ok: false, error: "INVALID_REQUEST" };
    if (method === "logout") {
      this.cancel();
      this.oauthError = undefined;
      this.auth.logout();
      return this.auth.status();
    }
    if (method === "status")
      return this.oauthError
        ? { ok: false, error: this.oauthError }
        : this.flow
          ? { ok: true, step: "oauth", authenticated: false }
          : this.auth.status();
    if (method === "cancel") {
      this.cancel();
      this.oauthError = undefined;
      return { ok: true, authenticated: false };
    }
    if (this.busy || this.flow) return { ok: false, error: "AUTH_BUSY" };
    this.busy = true;
    const generation = this.generation;
    this.oauthError = undefined;
    try {
      if (["register", "login", "verify", "resend"].includes(method)) {
        const result =
          method === "register"
            ? await this.auth.register(p.login, p.email, p.password)
            : method === "login"
              ? await this.auth.login(p.identifier, p.password)
              : method === "verify"
                ? await this.auth.verify(p.challengeId, p.code)
                : await this.auth.resend(p.challengeId);
        if (generation !== this.generation) {
          this.auth.logout();
          return { ok: false, authenticated: false, error: "AUTH_CANCELLED" };
        }
        return result;
      }
      if (method === "oauth") {
        if (p.provider !== "google" && p.provider !== "github") throw new AuthError("INVALID_REQUEST");
        const provider = p.provider,
          generation = ++this.generation;
        const opened = await beginOAuth(provider, this.env, this.browser, async (profile) => {
          await this.auth.acceptProvider(provider, profile);
          if (generation !== this.generation) {
            this.auth.logout();
            throw new AuthError("OAUTH_CANCELLED");
          }
        });
        if (generation !== this.generation) {
          opened.cancel();
          return { ok: true, authenticated: false };
        }
        this.flow = opened;
        const flow = opened;
        void flow.completion
          .catch((e) => {
            if (generation === this.generation) this.oauthError = e instanceof AuthError ? e.message : "OAUTH_FAILED";
          })
          .finally(() => {
            if (this.flow === flow) this.flow = undefined;
          });
        return { ok: true, step: "oauth", authenticated: false };
      }
      return { ok: false, error: "INVALID_REQUEST" };
    } catch (e) {
      return { ok: false, authenticated: false, error: e instanceof AuthError ? e.message : "AUTH_UNAVAILABLE" };
    } finally {
      this.busy = false;
    }
  }
}
