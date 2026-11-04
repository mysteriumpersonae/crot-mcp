/**
 * OAuth 2.0 access through the self-registered relay URL (owner-approved).
 *
 * The relay's authorization endpoint (src/cloud-relay/self-oauth.ts) shows the owner's consent and checks
 * the authorization code, redirect URI and PKCE; the token request then reaches this device through its
 * tunnel. The device authenticates the client itself: its OAuth client secret is a client token issued
 * here (tokens.issue), checked by its SHA-256 digest like a Bearer token. The device then mints a
 * short-lived access token and a rotating refresh token bound to that client token. Rotating, revoking or
 * expiring the client token ends every grant made with it. An access token authenticates exactly as its
 * client token (same principal, scopes and admission). Only SHA-256 digests persist.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { oauthClientCredentials, selfOAuthDevice, singleValueForm } from "../adapters/http/credentials.js";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import type { GrantParent } from "./client-tokens.js";
import { writePrivateFileAtomic } from "./secrets/backends.js";

/** Device-side path of the token endpoint (the relay forwards `/d/<deviceId>/oauth/token` here). */
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const ACCESS_TOKEN_PREFIX = "crot_at_";
export const REFRESH_TOKEN_PREFIX = "crot_rt_";
/** Access tokens live one hour (never past their client token); refresh tokens as long as the client token. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const MAX_GRANTS = 512;
const MAX_TOKEN_BODY = 8 * 1024;
const MAX_TOKEN_LENGTH = 256;
/** RFC 6749 scope: space-separated scope tokens. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;

export const oauthGrantPath = (dir: string) => path.join(dir, "client-oauth-grants.json");

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative();
const grantSchema = z
  .object({
    id: z.string().uuid(),
    parent: z.string().uuid(),
    generation: z.string().uuid(),
    access: hex,
    accessExpiresAt: time,
    refresh: hex,
    refreshExpiresAt: time,
    issuedAt: time,
  })
  .strict();
const fileSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema).max(MAX_GRANTS) }).strict();
type Grant = z.infer<typeof grantSchema>;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const matches = (value: Buffer, hexDigest: string): boolean => timingSafeEqual(value, Buffer.from(hexDigest, "hex"));

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

/** The client tokens the grants are bound to (ClientTokenRegistry). */
export interface GrantParents {
  grantParent(id: string, generation: string, touch?: boolean): Promise<GrantParent | undefined>;
  verifyAccessToken(token: string): Promise<AuthInfo | undefined>;
}

interface Options {
  readonly file: string;
  readonly privateFiles: PrivateFileProtection;
  readonly parents: GrantParents;
  readonly clock?: () => number;
}

export class OAuthGrants {
  private grants: Grant[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private broken = false;
  private readonly clock: () => number;

  private constructor(private readonly options: Options) {
    this.clock = options.clock ?? Date.now;
  }

  static async open(options: Options): Promise<OAuthGrants> {
    const store = new OAuthGrants(options);
    try {
      // Missing files are handled before protectFile: Windows ACL backends may wrap ENOENT.
      const info = await lstat(options.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new CrotError("CONFIG_ERROR", "Invalid OAuth grant file");
      if (options.privateFiles.protectFile) await options.privateFiles.protectFile(options.file);
      store.grants = fileSchema.parse(JSON.parse(await readFile(options.file, "utf8"))).grants;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(): Promise<void> {
    try {
      await writePrivateFileAtomic(
        this.options.file,
        JSON.stringify({ version: 1, grants: this.grants }),
        this.options.privateFiles,
      );
    } catch (error) {
      // Grants stop working rather than outliving a state that could not be recorded.
      this.broken = true;
      throw error;
    }
  }

  /** Grants still in force (tests and diagnostics). */
  get size(): number {
    return this.grants.length;
  }

  /** The parent of an authenticated client token (ClientTokenRegistry.verifyAccessToken). */
  static parentOf(info: AuthInfo | undefined): GrantParent | undefined {
    const extra = info?.extra ?? {};
    if (
      !info ||
      extra.authMethod !== "scoped-token" ||
      typeof extra.tokenId !== "string" ||
      typeof extra.tokenGeneration !== "string" ||
      typeof info.expiresAt !== "number" ||
      info.token.startsWith(ACCESS_TOKEN_PREFIX)
    )
      return undefined;
    return {
      id: extra.tokenId,
      generation: extra.tokenGeneration,
      scopes: [...info.scopes],
      expiresAt: info.expiresAt * 1000,
    };
  }

  /** A new grant for an authenticated client token (the relay checked the authorization code, if any). */
  issue(parent: GrantParent, scope?: string): Promise<OAuthTokenResponse> {
    return this.serial(async () => {
      if (this.broken) throw new CrotError("OPERATION_FAILED", "OAuth grants unavailable");
      await this.prune();
      // Bounded: the oldest grant goes first (its client authorizes again with its client secret).
      while (this.grants.length >= MAX_GRANTS) this.grants.shift();
      const grant: Grant = {
        id: randomUUID(),
        parent: parent.id,
        generation: parent.generation,
        access: "0".repeat(64),
        accessExpiresAt: 0,
        refresh: "0".repeat(64),
        refreshExpiresAt: 0,
        issuedAt: this.clock(),
      };
      const response = this.mint(grant, parent, scope);
      this.grants.push(grant);
      await this.save();
      return response;
    });
  }

  /** refresh_token: new access and refresh tokens (rotation); the old refresh token stops working. */
  refresh(parent: GrantParent, token: string, scope?: string): Promise<OAuthTokenResponse | undefined> {
    return this.serial(async () => {
      if (this.broken || !token.startsWith(REFRESH_TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH) return undefined;
      const presented = digest(token);
      const grant = this.grants.find((g) => matches(presented, g.refresh));
      if (!grant || grant.refreshExpiresAt <= this.clock()) return undefined;
      // A refresh token works only with the client secret it was granted to, while that token is active.
      if (grant.parent !== parent.id || grant.generation !== parent.generation) return undefined;
      if (!(await this.options.parents.grantParent(grant.parent, grant.generation, false))) return undefined;
      const response = this.mint(grant, parent, scope);
      await this.save();
      return response;
    });
  }

  /** An access token of a live grant authenticates as its client token. */
  async verifyAccessToken(token: string): Promise<AuthInfo | undefined> {
    if (this.broken || !token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH) return undefined;
    const presented = digest(token);
    const grant = this.grants.find((g) => matches(presented, g.access));
    if (!grant || grant.accessExpiresAt <= this.clock()) return undefined;
    const parent = await this.options.parents.grantParent(grant.parent, grant.generation);
    if (!parent) return undefined;
    const subject = `client-token:${parent.id}:${parent.generation}`;
    return {
      token,
      clientId: subject,
      scopes: [...parent.scopes],
      expiresAt: Math.floor(Math.min(grant.accessExpiresAt, parent.expiresAt) / 1000),
      extra: { subject, authMethod: "scoped-token", tokenId: parent.id, tokenGeneration: parent.generation },
    };
  }

  private mint(grant: Grant, parent: GrantParent, scope: string | undefined): OAuthTokenResponse {
    const now = this.clock();
    const access = ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const refresh = REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    grant.access = digest(access).toString("hex");
    grant.refresh = digest(refresh).toString("hex");
    grant.accessExpiresAt = Math.min(now + ACCESS_TOKEN_TTL_MS, parent.expiresAt);
    grant.refreshExpiresAt = parent.expiresAt;
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((grant.accessExpiresAt - now) / 1000)),
      refresh_token: refresh,
      scope: scope ?? parent.scopes.join(" "),
    };
  }

  /** Drop expired grants and grants whose client token was rotated, revoked or expired. */
  private async prune(): Promise<void> {
    const now = this.clock();
    const kept: Grant[] = [];
    for (const grant of this.grants)
      if (
        grant.refreshExpiresAt > now &&
        (await this.options.parents.grantParent(grant.parent, grant.generation, false))
      )
        kept.push(grant);
    this.grants = kept;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}

function answer(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    pragma: "no-cache",
    ...headers,
  });
  res.end(text);
}

const invalidClient = (res: ServerResponse) =>
  answer(res, 401, { error: "invalid_client" }, { "www-authenticate": 'Basic realm="crot"' });

function readLimited(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        resolve(undefined);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(size > max ? undefined : Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

/**
 * The device's token endpoint (`POST /oauth/token`, form-encoded): `client_credentials` (what the relay
 * sends after it checked an authorization code) and `refresh_token`. The client authenticates with
 * `client_secret_basic` or `client_secret_post`; its id is `crot-<deviceId>` (or the bare device id) and
 * its secret a client token of this device.
 */
export class OAuthTokenEndpoint {
  constructor(
    private readonly options: {
      readonly grants: OAuthGrants;
      readonly parents: GrantParents;
      /** This device's self-registered id, or undefined while it has none. */
      readonly deviceId: () => string | undefined;
      readonly log?: (message: string) => void;
    },
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Server-to-server only (the relay never forwards a browser Origin): no CORS, no ambient credentials.
    if (req.headers.origin !== undefined) {
      req.resume();
      return answer(res, 403, { error: "invalid_request" });
    }
    if (req.method !== "POST") {
      req.resume();
      return answer(res, 405, { error: "invalid_request" }, { allow: "POST" });
    }
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      req.resume();
      return answer(res, 400, { error: "invalid_request" });
    }
    const raw = await readLimited(req, MAX_TOKEN_BODY);
    if (!raw) return answer(res, 413, { error: "invalid_request" });
    const form = singleValueForm(raw.toString("utf8"));
    if (!form) return answer(res, 400, { error: "invalid_request" });
    const client = oauthClientCredentials(req.headers.authorization, form);
    if (client === "invalid") return answer(res, 400, { error: "invalid_request" });
    const deviceId = this.options.deviceId();
    if (!client || !deviceId || selfOAuthDevice(client.id) !== deviceId) return invalidClient(res);
    const parent = OAuthGrants.parentOf(await this.options.parents.verifyAccessToken(client.secret));
    if (!parent) {
      this.options.log?.("oauth: refused a token request with an invalid client secret");
      return invalidClient(res);
    }
    const scope = form.get("scope") ?? undefined;
    if (scope !== undefined && (scope.length > 256 || !SCOPE.test(scope)))
      return answer(res, 400, { error: "invalid_scope" });
    const grantType = form.get("grant_type");
    try {
      if (grantType === "client_credentials") return answer(res, 200, await this.options.grants.issue(parent, scope));
      if (grantType === "refresh_token") {
        const refreshed = await this.options.grants.refresh(parent, form.get("refresh_token") ?? "", scope);
        return refreshed ? answer(res, 200, refreshed) : answer(res, 400, { error: "invalid_grant" });
      }
    } catch {
      return answer(res, 503, { error: "temporarily_unavailable" });
    }
    return answer(res, 400, { error: "unsupported_grant_type" });
  }
}
