/** Desktop sign-in only. Never creates a Core/remote principal or a paid entitlement. */
import { randomBytes, randomInt, scrypt as derive, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, lstat, unlink } from "node:fs/promises";
import path from "node:path";
export type Provider = "google" | "github";
export interface Profile {
  id: string;
  login: string;
  email: string;
  name?: string;
  avatar?: string;
}
interface User extends Profile {
  status: "pending_verification" | "active";
  password?: string;
  provider?: { name: Provider; subject: string };
  challenge?: { id: string; hash: string; expires: number; resendAt: number; attempts: number };
}
interface Database {
  version: 1;
  users: User[];
}
export interface AuthResult {
  ok: boolean;
  authenticated?: boolean;
  profile?: Profile;
  step?: "verify" | "oauth";
  challengeId?: string;
  retryAfter?: number;
  delivery?: "smtp" | "development";
  error?: string;
}
export class AuthError extends Error {}
const secret = () => randomBytes(32).toString("base64url");
const emailPattern =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
export const validEmail = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 254 &&
  emailPattern.test(v) &&
  !v.startsWith(".") &&
  !v.includes("..") &&
  !v.includes(".@");
export const validLogin = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/.test(v);
const normalize = (s: string) => s.trim().toLowerCase();
async function hash(value: string, salt = randomBytes(16).toString("hex")): Promise<string> {
  const key = await new Promise<Buffer>((yes, no) =>
    derive(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, b) => (e ? no(e) : yes(b))),
  );
  return salt + ":" + key.toString("hex");
}
async function matches(value: string, stored: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) return false;
  const actual = await hash(value, stored.split(":")[0]);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(stored));
}
export interface AuthOptions {
  deliverCode(email: string, code: string): Promise<"smtp" | "development">;
  now?: () => number;
}
/** Single owner-process writer, serialized durable-before-visible transactions; no renderer-supplied paths. */
export class DesktopAuth {
  private data: Database = { version: 1, users: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private session?: { id: string; account: string; expires: number };
  private attempts = new Map<string, { count: number; expires: number }>();
  private dummy = "";
  private constructor(
    private file: string,
    private options: AuthOptions,
  ) {}
  static async open(file: string, options: AuthOptions): Promise<DesktopAuth> {
    const auth = new DesktopAuth(file, options);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const dir = await lstat(path.dirname(file));
    if (dir.isSymbolicLink() || !dir.isDirectory() || (process.platform !== "win32" && dir.mode & 0o077))
      throw new AuthError("UNSAFE_STORAGE");
    try {
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 16 * 1024 * 1024 ||
        (process.platform !== "win32" && info.mode & 0o077)
      )
        throw new AuthError("UNSAFE_STORAGE");
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const state: Database = JSON.parse(await handle.readFile("utf8"));
        if (state.version !== 1 || !Array.isArray(state.users) || state.users.length > 10000)
          throw new AuthError("UNSAFE_STORAGE");
        const emails = new Set<string>(),
          logins = new Set<string>(),
          ids = new Set<string>(),
          providers = new Set<string>();
        for (const u of state.users) {
          if (
            !u ||
            !validEmail(u.email) ||
            !validLogin(u.login) ||
            !/^[\w-]{43}$/.test(u.id) ||
            !["active", "pending_verification"].includes(u.status) ||
            emails.has(normalize(u.email)) ||
            logins.has(normalize(u.login)) ||
            ids.has(u.id)
          )
            throw new AuthError("UNSAFE_STORAGE");
          emails.add(normalize(u.email));
          logins.add(normalize(u.login));
          ids.add(u.id);
          if (u.password && !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.password)) throw new AuthError("UNSAFE_STORAGE");
          if (!u.password && !u.provider) throw new AuthError("UNSAFE_STORAGE");
          if (u.provider) {
            const key = u.provider.name + ":" + u.provider.subject;
            if (
              !["google", "github"].includes(u.provider.name) ||
              typeof u.provider.subject !== "string" ||
              u.provider.subject.length > 256 ||
              providers.has(key)
            )
              throw new AuthError("UNSAFE_STORAGE");
            providers.add(key);
          }
          // Challenges are deliberately not restored: stale codes never revive after a restart.
          delete u.challenge;
        }
        auth.data = state;
      } finally {
        await handle.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    auth.dummy = await hash(secret());
    return auth;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const p = this.queue.then(work);
    this.queue = p.catch(() => undefined);
    return p;
  }
  private limit(key: string, max = 5, period = 60000) {
    const now = this.now();
    for (const [k, v] of this.attempts) if (v.expires <= now) this.attempts.delete(k);
    const count = this.attempts.get(key) ?? { count: 0, expires: now + period };
    if (count.count >= max) throw new AuthError("RATE_LIMITED");
    count.count++;
    this.attempts.set(key, count);
  }
  private async commit(next: Database) {
    const temp = this.file + "." + secret() + ".tmp";
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.file);
      this.data = next;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  private publicUser(u: User): Profile {
    return {
      id: u.id,
      login: u.login,
      email: u.email,
      ...(u.name ? { name: u.name } : {}),
      ...(u.avatar ? { avatar: u.avatar } : {}),
    };
  }
  status(): AuthResult {
    if (!this.session || this.session.expires <= this.now()) {
      this.session = undefined;
      return { ok: true, authenticated: false };
    }
    const user = this.data.users.find((u) => u.id === this.session!.account && u.status === "active");
    return user
      ? { ok: true, authenticated: true, profile: this.publicUser(user) }
      : { ok: true, authenticated: false };
  }
  logout() {
    this.session = undefined;
  }
  private admit(user: User): AuthResult {
    this.session = { id: secret(), account: user.id, expires: this.now() + 12 * 60 * 60 * 1000 };
    return this.status();
  }
  private async issue(next: Database, user: User): Promise<AuthResult> {
    const code = randomInt(0, 1000000).toString().padStart(6, "0"),
      now = this.now();
    user.challenge = {
      id: secret(),
      hash: await hash(code),
      expires: now + 600000,
      resendAt: now + 60000,
      attempts: 0,
    };
    // Durably reserve uniqueness first, but failed delivery must not leave a usable code.
    await this.commit(next);
    let delivery: "smtp" | "development";
    try {
      delivery = await this.options.deliverCode(user.email, code);
    } catch {
      const rollback = structuredClone(this.data);
      delete rollback.users.find((u) => u.id === user.id)!.challenge;
      await this.commit(rollback);
      throw new AuthError("EMAIL_DELIVERY_FAILED");
    }
    return { ok: true, step: "verify", authenticated: false, challengeId: user.challenge.id, retryAfter: 60, delivery };
  }
  register(login: unknown, email: unknown, password: unknown): Promise<AuthResult> {
    return this.serial(async () => {
      this.limit("register", 5, 600000);
      if (
        !validLogin(login) ||
        !validEmail(email) ||
        typeof password !== "string" ||
        password.length < 8 ||
        password.length > 256
      )
        throw new AuthError("INVALID_REGISTRATION");
      const next = structuredClone(this.data);
      if (next.users.some((u) => normalize(u.login) === normalize(login))) throw new AuthError("LOGIN_TAKEN");
      if (next.users.some((u) => normalize(u.email) === normalize(email))) throw new AuthError("EMAIL_TAKEN");
      if (next.users.length >= 10000) throw new AuthError("REGISTRATION_UNAVAILABLE");
      const user: User = {
        id: secret(),
        login,
        email: normalize(email),
        status: "pending_verification",
        password: await hash(password),
      };
      next.users.push(user);
      return this.issue(next, user);
    });
  }
  login(identifier: unknown, password: unknown): Promise<AuthResult> {
    return this.serial(async () => {
      this.limit("login", 10, 60000);
      if (
        typeof identifier !== "string" ||
        identifier.length > 254 ||
        typeof password !== "string" ||
        !password ||
        password.length > 256
      )
        throw new AuthError("INVALID_CREDENTIALS");
      const user = this.data.users.find(
        (u) => normalize(u.login) === normalize(identifier) || normalize(u.email) === normalize(identifier),
      );
      const valid = await matches(password, user?.password ?? this.dummy);
      if (!user || !user.password || !valid) throw new AuthError("INVALID_CREDENTIALS");
      if (user.status !== "active") {
        if (user.challenge && user.challenge.resendAt > this.now())
          return {
            ok: true,
            authenticated: false,
            step: "verify",
            challengeId: user.challenge.id,
            retryAfter: Math.ceil((user.challenge.resendAt - this.now()) / 1000),
          };
        const next = structuredClone(this.data);
        return this.issue(
          next,
          next.users.find((u) => u.id === user.id)!,
        );
      }
      return this.admit(user);
    });
  }
  resend(challenge: unknown): Promise<AuthResult> {
    return this.serial(async () => {
      this.limit("resend", 5, 600000);
      const next = structuredClone(this.data),
        user = next.users.find((u) => u.challenge?.id === challenge);
      if (!user?.challenge || user.status !== "pending_verification") throw new AuthError("INVALID_CODE");
      if (user.challenge.resendAt > this.now()) throw new AuthError("RESEND_WAIT");
      return this.issue(next, user);
    });
  }
  verify(challenge: unknown, code: unknown): Promise<AuthResult> {
    return this.serial(async () => {
      this.limit("verify", 10, 60000);
      const next = structuredClone(this.data),
        user = next.users.find((u) => u.challenge?.id === challenge),
        c = user?.challenge;
      if (
        !user ||
        user.status !== "pending_verification" ||
        !c ||
        c.expires <= this.now() ||
        c.attempts >= 5 ||
        typeof code !== "string" ||
        !/^\d{6}$/.test(code)
      )
        throw new AuthError("INVALID_CODE");
      c.attempts++;
      const valid = await matches(code, c.hash);
      if (valid) {
        user.status = "active";
        delete user.challenge;
      }
      await this.commit(next);
      if (!valid) throw new AuthError("INVALID_CODE");
      return this.admit(user);
    });
  }
  /** Called only with a profile fetched by the trusted OAuth module, never renderer input. */
  acceptProvider(
    provider: Provider,
    profile: { subject: string; email: string; login: string; name?: string; avatar?: string },
  ): Promise<AuthResult> {
    return this.serial(async () => {
      if (!validEmail(profile.email) || !profile.subject || profile.subject.length > 256)
        throw new AuthError("OAUTH_PROFILE_INVALID");
      const next = structuredClone(this.data);
      let user = next.users.find((u) => u.provider?.name === provider && u.provider.subject === profile.subject);
      // Never auto-link an email to a password account (or a different provider).
      if (next.users.some((u) => normalize(u.email) === normalize(profile.email) && u.id !== user?.id))
        throw new AuthError("ACCOUNT_LINK_REQUIRED");
      if (!user) {
        if (next.users.length >= 10000) throw new AuthError("REGISTRATION_UNAVAILABLE");
        let login = profile.login.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 20);
        if (!validLogin(login)) login = "user_" + randomBytes(6).toString("hex");
        if (next.users.some((u) => normalize(u.login) === normalize(login)))
          login += "_" + randomBytes(4).toString("hex");
        user = {
          id: secret(),
          login,
          email: normalize(profile.email),
          status: "active",
          provider: { name: provider, subject: profile.subject },
        };
        next.users.push(user);
      }
      user.email = normalize(profile.email);
      user.name = profile.name?.slice(0, 128);
      user.avatar = profile.avatar?.slice(0, 2048);
      await this.commit(next);
      return this.admit(user);
    });
  }
}
