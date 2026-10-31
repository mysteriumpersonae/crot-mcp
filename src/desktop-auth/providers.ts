/** Main-only OS credential vault. No file/env/kernel-keyring/plaintext fallback. */
import { smtpTransport, type AuthEnvironment } from "./config.js";
import { validEmail } from "./store.js";
const fields = ["googleId", "googleSecret", "githubId", "githubSecret", "gmail", "appPassword"] as const;
export type ProviderInput = Record<(typeof fields)[number], string>;
export interface CredentialEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
}
export class ProviderError extends Error {}
export function validateProviders(input: unknown): ProviderInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProviderError("PROVIDER_FORMAT");
  const p = input as Record<string, unknown>;
  if (Object.keys(p).length !== 6 || fields.some((k) => typeof p[k] !== "string" || (p[k] as string).length > 512))
    throw new ProviderError("PROVIDER_FORMAT");
  const v = Object.fromEntries(fields.map((k) => [k, (p[k] as string).trim()])) as ProviderInput;
  v.appPassword = v.appPassword.replace(/ /g, "");
  if (
    !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(v.googleId) ||
    !/^[A-Za-z0-9_-]{12,256}$/.test(v.googleSecret) ||
    !/^[A-Za-z0-9_]{10,128}$/.test(v.githubId) ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(v.githubSecret) ||
    !validEmail(v.gmail) ||
    !/@(?:gmail\.com|googlemail\.com)$/i.test(v.gmail) ||
    !/^[a-zA-Z]{16}$/.test(v.appPassword) ||
    Buffer.byteLength(JSON.stringify(v)) > 1200
  )
    throw new ProviderError("PROVIDER_FORMAT");
  return v;
}
export function providerEnvironment(v: ProviderInput): AuthEnvironment {
  return {
    GOOGLE_CLIENT_ID: v.googleId,
    GOOGLE_CLIENT_SECRET: v.googleSecret,
    GITHUB_CLIENT_ID: v.githubId,
    GITHUB_CLIENT_SECRET: v.githubSecret,
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_USER: v.gmail,
    SMTP_FROM: v.gmail,
    SMTP_PASS: v.appPassword,
    CROT_AUTH_CALLBACK_PORT: "43821",
  };
}
export async function systemCredentialEntry(): Promise<CredentialEntry> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("CROT.DesktopAuth.Providers.v1", "local-owner", { linux: { store: "secret-service" } });
  } catch {
    throw new ProviderError("SECRET_STORE_UNAVAILABLE");
  }
}
export async function verifyGmail(v: ProviderInput) {
  const transport = smtpTransport(providerEnvironment(v));
  try {
    await transport.verify();
  } catch {
    throw new ProviderError("SMTP_VERIFY_FAILED");
  } finally {
    transport.close();
  }
}
export class ProviderSettings {
  private busy = false;
  constructor(
    private entry: () => Promise<CredentialEntry> = systemCredentialEntry,
    private verify: (v: ProviderInput) => Promise<void> = verifyGmail,
  ) {}
  async load(): Promise<AuthEnvironment | undefined> {
    try {
      const value = await (await this.entry()).getPassword();
      return value === null ? undefined : providerEnvironment(validateProviders(JSON.parse(value)));
    } catch {
      throw new ProviderError("SECRET_STORE_UNAVAILABLE");
    }
  }
  async call(method: unknown, input: unknown) {
    if (method === "providers-status") {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
        return { ok: false, error: "INVALID_REQUEST" };
      try {
        return { ok: true, configured: !!(await this.load()) };
      } catch {
        return { ok: false, configured: false, error: "SECRET_STORE_UNAVAILABLE" };
      }
    }
    if (method !== "providers-save") return { ok: false, error: "INVALID_REQUEST" };
    if (this.busy) return { ok: false, error: "AUTH_BUSY" };
    this.busy = true;
    try {
      const v = validateProviders(input);
      const entry = await this.entry();
      await this.verify(v);
      await entry.setPassword(JSON.stringify(v));
      return { ok: true, configured: true, smtpVerified: true, oauthFormatValid: true };
    } catch (e) {
      return { ok: false, error: e instanceof ProviderError ? e.message : "SECRET_STORE_UNAVAILABLE" };
    } finally {
      this.busy = false;
    }
  }
}
