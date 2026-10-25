/** AD-63: native PKCE client -> confidential Notion OAuth, never a general HTTP proxy. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { WindowCounter } from "../cloud-relay/limits.js";

export const NOTION_NATIVE_CLIENT = "crot-desktop";
const PREFIX = "/oauth/notion/";
const nonce = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bounded = z
  .string()
  .min(1)
  .max(2560)
  .regex(/^[^\r\n\0]+$/);
const nativeNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nativeClient = z.literal(NOTION_NATIVE_CLIENT);
const redirect = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "http:" &&
        u.hostname === "127.0.0.1" &&
        !!u.port &&
        Number(u.port) > 0 &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        /^\/oauth\/callback\/[A-Za-z0-9_-]{43}$/.test(u.pathname)
      );
    } catch {
      return false;
    }
  });
const authorization = z
  .object({
    client_id: nativeClient,
    response_type: z.literal("code"),
    redirect_uri: redirect,
    state: nativeNonce,
    code_challenge: nativeNonce,
    code_challenge_method: z.literal("S256"),
    scope: z.literal("").optional(),
  })
  .strict();
const exchange = z
  .object({
    client_id: nativeClient,
    grant_type: z.literal("authorization_code"),
    code: nativeNonce,
    code_verifier: nativeNonce,
    redirect_uri: redirect,
  })
  .strict();
interface Flow {
  redirect: string;
  state: string;
  challenge: string;
  expires: number;
  code?: string;
}
interface Endpoints {
  authorize: string;
  token: string;
  revoke: string;
}
export interface NotionBrokerOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly publicOrigin: string;
  readonly now?: () => number;
}
class BrokerAuthorizationError extends Error {}
const production: Endpoints = {
  authorize: "https://api.notion.com/v1/oauth/authorize",
  token: "https://api.notion.com/v1/oauth/token",
  revoke: "https://api.notion.com/v1/oauth/revoke",
};
const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function params(value: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of value) {
    if (Object.hasOwn(out, key)) throw new Error("Duplicate parameter");
    out[key] = entry;
  }
  return out;
}
async function body(req: IncomingMessage): Promise<Record<string, string>> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new Error("Invalid content type");
  const timer = setTimeout(() => req.destroy(), 10_000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const b = Buffer.from(chunk as Uint8Array);
      bytes += b.length;
      if (bytes > 8192) throw new Error("Request too large");
      chunks.push(b);
    }
    return params(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  } finally {
    clearTimeout(timer);
  }
}
/** Single-process ephemeral flows. Restart loses pending authorizations, not user credentials. */
export class NotionOAuthBroker {
  private readonly flows = new Map<string, Flow>();
  private readonly grants = new Map<string, Flow>();
  private readonly now: () => number;
  private readonly limit: WindowCounter;
  private readonly callback: string;
  constructor(
    private readonly options: NotionBrokerOptions,
    private readonly endpoints: Endpoints = production,
  ) {
    bounded.parse(options.clientId);
    bounded.parse(options.clientSecret);
    const u = new URL(options.publicOrigin);
    const fixture = endpoints !== production;
    if (
      u.origin !== options.publicOrigin ||
      u.username ||
      u.password ||
      (fixture ? u.protocol !== "http:" || u.hostname !== "127.0.0.1" : u.origin !== "https://mcp.crot.network")
    )
      throw new Error("Invalid broker origin");
    for (const endpoint of Object.values(endpoints)) {
      const target = new URL(endpoint);
      if (
        target.username ||
        target.password ||
        (fixture ? target.protocol !== "http:" || target.hostname !== "127.0.0.1" : target.protocol !== "https:")
      )
        throw new Error("Invalid provider endpoint");
    }
    this.callback = `${u.origin}${PREFIX}callback`;
    this.now = options.now ?? Date.now;
    this.limit = new WindowCounter({ max: 60, windowMs: 60_000 }, this.now, 10_000);
  }
  private prune(): void {
    for (const map of [this.flows, this.grants])
      for (const [id, flow] of map) if (flow.expires <= this.now()) map.delete(id);
  }
  private async provider(url: string, payload: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`,
        "Notion-Version": "2026-03-11",
      },
      body: JSON.stringify(payload),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader)
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 65536) throw new Error("Provider response too large");
          chunks.push(item.value);
        }
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const data: unknown = raw ? JSON.parse(raw) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid provider response");
    if (!response.ok) {
      if (response.status === 401 || (data as Record<string, unknown>).error === "invalid_grant")
        throw new BrokerAuthorizationError("Provider authorization expired");
      throw new Error("Provider rejected request");
    }
    return data as Record<string, unknown>;
  }
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith(PREFIX)) return false;
    this.prune();
    if (this.limit.take(req.socket.remoteAddress ?? "unknown") !== undefined) {
      req.resume();
      reply(res, 429, { error: "rate_limited" });
      return true;
    }
    try {
      if (req.headers.origin || (req.url?.length ?? 0) > 8192 || !req.url?.startsWith("/") || req.url.startsWith("//"))
        throw new Error("Invalid request");
      const url = new URL(req.url, this.options.publicOrigin);
      if (pathname === `${PREFIX}authorize` && req.method === "GET") {
        const input = authorization.parse(params(url.searchParams));
        if (this.flows.size + this.grants.size >= 500) {
          reply(res, 503, { error: "capacity" });
          return true;
        }
        const state = nonce();
        this.flows.set(hash(state), {
          redirect: input.redirect_uri,
          state: input.state,
          challenge: input.code_challenge,
          expires: this.now() + 300_000,
        });
        const next = new URL(this.endpoints.authorize);
        next.search = new URLSearchParams({
          client_id: this.options.clientId,
          response_type: "code",
          owner: "user",
          redirect_uri: this.callback,
          state,
        }).toString();
        res.writeHead(302, { ...headers, location: next.href });
        res.end();
        return true;
      }
      if (pathname === `${PREFIX}callback` && req.method === "GET") {
        const input = z
          .object({ state: nativeNonce, code: bounded.optional(), error: bounded.optional() })
          .strict()
          .parse(params(url.searchParams));
        if (!!input.code === !!input.error) throw new Error("Invalid callback");
        const key = hash(input.state);
        const flow = this.flows.get(key);
        if (!flow) throw new Error("Unknown flow");
        this.flows.delete(key);
        const next = new URL(flow.redirect);
        next.searchParams.set("state", flow.state);
        if (input.error) next.searchParams.set("error", "access_denied");
        else {
          const grant = nonce();
          flow.code = input.code;
          this.grants.set(hash(grant), flow);
          next.searchParams.set("code", grant);
        }
        res.writeHead(302, { ...headers, location: next.href });
        res.end();
        return true;
      }
      if (req.method !== "POST" || url.search) throw new Error("Invalid method");
      const input = await body(req);
      let result: Record<string, unknown>;
      if (pathname === `${PREFIX}token`) {
        const value = exchange.parse(input);
        const key = hash(value.code);
        const flow = this.grants.get(key);
        if (
          !flow?.code ||
          flow.expires <= this.now() ||
          flow.redirect !== value.redirect_uri ||
          !equal(hash(value.code_verifier), flow.challenge)
        )
          throw new Error("Invalid grant");
        this.grants.delete(key); // consume before external I/O; never retry ambiguous exchanges
        result = await this.provider(this.endpoints.token, {
          grant_type: "authorization_code",
          code: flow.code,
          redirect_uri: this.callback,
        });
      } else if (pathname === `${PREFIX}refresh`) {
        const value = z.object({ client_id: nativeClient, refresh_token: bounded }).strict().parse(input);
        result = await this.provider(this.endpoints.token, {
          grant_type: "refresh_token",
          refresh_token: value.refresh_token,
        });
      } else if (pathname === `${PREFIX}revoke`) {
        const value = z.object({ client_id: nativeClient, token: bounded }).strict().parse(input);
        await this.provider(this.endpoints.revoke, { token: value.token });
        reply(res, 200, {});
        return true;
      } else throw new Error("Unknown operation");
      // Never forward provider metadata, secrets, or unvalidated responses wholesale.
      const tokens = z
        .object({
          access_token: bounded,
          refresh_token: bounded.optional(),
          expires_in: z.number().int().positive().max(31_536_000).optional(),
        })
        .parse(result);
      reply(res, 200, tokens);
    } catch (error) {
      req.resume();
      reply(res, 400, { error: error instanceof BrokerAuthorizationError ? "invalid_grant" : "oauth_request_failed" });
    }
    return true;
  }
}
/** Trusted local integration seam; never populated from deployment/renderer JSON. */
export function fixtureNotionOAuthBroker(options: NotionBrokerOptions, origin: string): NotionOAuthBroker {
  const u = new URL(origin);
  if (u.origin !== origin || u.protocol !== "http:" || u.hostname !== "127.0.0.1")
    throw new Error("Invalid fixture origin");
  return new NotionOAuthBroker(options, {
    authorize: `${origin}/authorize`,
    token: `${origin}/token`,
    revoke: `${origin}/revoke`,
  });
}
