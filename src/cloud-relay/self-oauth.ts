/**
 * OAuth 2.0 for the relay URL of a self-registered device (owner-approved), for MCP clients that offer
 * OAuth only or prefer it (Notion, Claude, ChatGPT, n8n and others):
 *
 *   MCP server URL       https://<relay>/d/<deviceId>/mcp
 *   OAuth Client ID      crot-<deviceId>
 *   OAuth Client Secret  a client token of the device (tokens.issue: the token a Bearer client uses)
 *
 * Discovery (MCP authorization: RFC 9728, RFC 8414): the device's Protected Resource Metadata names the
 * issuer `https://<relay>/d/<deviceId>`, whose metadata is served at
 * `/.well-known/oauth-authorization-server/d/<deviceId>` and `/d/<deviceId>/.well-known/...`. Clients that
 * look for metadata at the relay's root get the relay-wide issuer `https://<relay>`, which names the device
 * by the client id.
 *
 * The relay keeps no client secrets and verifies none. Its authorization endpoint shows a consent page and,
 * after the owner allows, issues a single-use authorization code (five minutes, memory only) bound to the
 * device, redirect URI, PKCE challenge and scope. Its token endpoint checks the code and forwards the token
 * request through the device's tunnel as a `client_credentials` grant: the device authenticates the client
 * secret and mints the access and refresh tokens (src/service/oauth-grants.ts). Refresh and
 * client-credentials grants are forwarded as they are. The authorization endpoint never redirects by
 * itself: every redirect follows the owner's Allow or Deny, and an invalid request gets an error page.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { oauthClientCredentials, selfOAuthDevice, singleValueForm } from "../adapters/http/credentials.js";
import { canonicalDeviceUri } from "../identity/device-id.js";
import { WindowCounter } from "./limits.js";

const ID = "([a-z2-7]{26})";
const DEVICE_METADATA = [
  new RegExp(`^/\\.well-known/oauth-authorization-server/d/${ID}$`),
  new RegExp(`^/d/${ID}/\\.well-known/oauth-authorization-server$`),
];
const DEVICE_AUTHORIZE = new RegExp(`^/d/${ID}/oauth/authorize$`);
const DEVICE_TOKEN = new RegExp(`^/d/${ID}/oauth/token$`);
const ROOT_METADATA = "/.well-known/oauth-authorization-server";
const ROOT_AUTHORIZE = "/oauth/authorize";
const ROOT_TOKEN = "/oauth/token";

/** Advertised scope; any well-formed scope is accepted and echoed (the client token's own scopes apply). */
export const SELF_OAUTH_SCOPES: readonly string[] = Object.freeze(["mcp"]);
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
/** How long a consent page stays valid. */
const REQUEST_TTL_MS = 15 * 60_000;
const MAX_CODES = 2048;
const MAX_FORM_BYTES = 8 * 1024;
const FORM_TIMEOUT_MS = 10_000;
const MAX_URI = 2048;
const MAX_STATE = 1024;
const MAX_SCOPE = 256;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** Schemes a redirect URI never uses: script and local content, and other protocols. */
const REFUSED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
  "ws:",
  "wss:",
  "ftp:",
  "mailto:",
  "tel:",
  "sms:",
]);

export interface ForwardedTokenRequest {
  readonly deviceId: string;
  /** client_secret_basic with the client's own id and secret: the device authenticates the client. */
  readonly authorization: string;
  /** The form the device receives (`client_credentials` or `refresh_token`). */
  readonly body: Buffer;
  /** The client's relay-side key for rate limits (a digest prefix of its secret, never the secret). */
  readonly clientKey: string;
}

export interface SelfOAuthOptions {
  readonly relayHost: string;
  /** Also the relay-wide issuer at the root (off when the relay's host is the paired issuer's). */
  readonly root: boolean;
  readonly now: () => number;
  /** Whether a device is self-registered at this relay (and not revoked). */
  readonly isSelfDevice: (deviceId: string) => Promise<boolean>;
  /** Forward a composed token request through the device's tunnel; the device's response is the answer. */
  readonly forward: (req: IncomingMessage, res: ServerResponse, request: ForwardedTokenRequest) => Promise<void>;
  readonly discard: (req: IncomingMessage) => void;
  readonly log: (record: { event: string; deviceId?: string; status: number; code: string }) => void;
}

export type SelfOAuthRoute =
  | { readonly kind: "metadata" | "authorize" | "token"; readonly device: string }
  | { readonly kind: "metadata" | "authorize" | "token"; readonly device?: undefined };

interface Issuer {
  /** Issuer identifier and base of its endpoints. */
  readonly id: string;
  /** The device of a device issuer; undefined for the relay-wide issuer. */
  readonly device: string | undefined;
}

/** A consent page's authorization request, signed by the relay (no server-side state before consent). */
interface Pending {
  readonly d: string;
  readonly r: string;
  readonly i: string;
  readonly e: number;
  readonly s?: string;
  readonly p?: string;
  readonly o?: string;
}

interface Code {
  readonly device: string;
  readonly redirect: string;
  readonly challenge: string | undefined;
  readonly scope: string | undefined;
  readonly expires: number;
}

const CORS = { "access-control-allow-origin": "*" } as const;
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
} as const;
const BASIC_CHALLENGE = { "www-authenticate": 'Basic realm="crot"' } as const;

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const mediaType = (req: IncomingMessage): string =>
  String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

function readForm(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), FORM_TIMEOUT_MS);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_FORM_BYTES) return finish(undefined);
      chunks.push(chunk);
    });
    req.once("end", () => {
      try {
        finish(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        finish(undefined);
      }
    });
    req.once("close", () => finish(undefined));
    req.once("error", () => finish(undefined));
  });
}

/** A redirect URI the owner may be sent back to (RFC 8252 loopback and private-use schemes included). */
function redirectUri(value: string | null): URL | undefined {
  if (!value || value.length > MAX_URI) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hash || value.includes("#") || url.username || url.password) return undefined;
  if (url.protocol === "https:") return url.hostname ? url : undefined;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname) ? url : undefined;
  return /^[a-z][a-z0-9+.-]{0,63}:$/.test(url.protocol) && !REFUSED_SCHEMES.has(url.protocol) ? url : undefined;
}

/** The CSP source of a redirect target: its origin, or its scheme for a private-use scheme. */
const redirectSource = (url: URL): string =>
  url.protocol === "https:" || url.protocol === "http:" ? url.origin : url.protocol;

const validScope = (scope: string): boolean => scope.length <= MAX_SCOPE && SCOPE.test(scope);

type Lang = "en" | "ru";
const TEXT = {
  en: {
    title: "Allow access to your CROT device?",
    intro: (device: string, host: string) =>
      `An application asks to connect to CROT device <code>${device}</code> through <b>${host}</b>.`,
    target: "After your choice you return to",
    scope: "Requested scope",
    note: "The application gets only the access of the client token entered as its OAuth Client Secret, and only if that secret is correct. Allow only if you started this connection yourself.",
    allow: "Allow",
    deny: "Deny",
    errorTitle: "This authorization request cannot be completed",
    errors: {
      unknown_client:
        "The OAuth Client ID must be crot-<device id> of a device that is registered with this relay (remote access on in CROT).",
      invalid_redirect:
        "The redirect URL is missing or not allowed: use https, or http on 127.0.0.1, [::1] or localhost.",
      unsupported_response_type: "Only the authorization code flow (response_type=code) is supported.",
      invalid_pkce: "PKCE must use the S256 method with a valid code challenge.",
      invalid_scope: "The requested scope is not valid.",
      invalid_target: "The resource is not this device's MCP URL.",
      invalid_request: "The authorization request is malformed (a parameter is repeated or too long).",
      expired: "This page has expired. Start the connection again from the application.",
      forbidden: "The decision did not come from this page. Start the connection again from the application.",
      rate_limited: "Too many authorizations for this device. Wait a minute and try again.",
    },
  },
  ru: {
    title: "Разрешить доступ к вашему устройству CROT?",
    intro: (device: string, host: string) =>
      `Приложение запрашивает подключение к устройству CROT <code>${device}</code> через <b>${host}</b>.`,
    target: "После выбора вы вернётесь на",
    scope: "Запрошенная область (scope)",
    note: "Приложение получит только доступ клиентского токена, указанного как OAuth Client Secret, и только если этот секрет верный. Разрешайте, только если подключение начали вы сами.",
    allow: "Разрешить",
    deny: "Отклонить",
    errorTitle: "Этот запрос авторизации нельзя выполнить",
    errors: {
      unknown_client:
        "OAuth Client ID должен быть crot-<id устройства> устройства, зарегистрированного на этом relay (удалённый доступ включён в CROT).",
      invalid_redirect:
        "Redirect URL не указан или не разрешён: используйте https или http на 127.0.0.1, [::1] либо localhost.",
      unsupported_response_type: "Поддерживается только поток с кодом авторизации (response_type=code).",
      invalid_pkce: "PKCE должен использовать метод S256 с корректным code challenge.",
      invalid_scope: "Запрошенная область (scope) некорректна.",
      invalid_target: "Ресурс (resource) не совпадает с MCP URL этого устройства.",
      invalid_request: "Запрос авторизации некорректен (параметр повторяется или слишком длинный).",
      expired: "Срок действия страницы истёк. Начните подключение заново из приложения.",
      forbidden: "Решение отправлено не с этой страницы. Начните подключение заново из приложения.",
      rate_limited: "Слишком много авторизаций для этого устройства. Подождите минуту и повторите.",
    },
  },
} as const;
type ErrorCode = keyof (typeof TEXT)["en"]["errors"];

const STYLE =
  "body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1d1f23}" +
  "main{max-width:520px;margin:48px auto;padding:28px;background:#fff;border:1px solid #e3e5e8;border-radius:12px}" +
  "h1{font-size:22px;margin:0 0 16px}code{font-size:14px;background:#f0f1f3;padding:1px 5px;border-radius:4px;word-break:break-all}" +
  "dl{margin:16px 0}dt{color:#5f6670;font-size:14px}dd{margin:0 0 10px;word-break:break-all}" +
  ".note{color:#5f6670;font-size:14px}form{display:flex;gap:12px;margin-top:20px}" +
  "button{flex:1;padding:10px 16px;font-size:16px;border-radius:8px;border:1px solid #c9ccd1;background:#fff;cursor:pointer}" +
  "button.allow{background:#1f6feb;border-color:#1f6feb;color:#fff}";

/** The relay-side OAuth endpoints of self-registered devices; see the module comment. */
export class SelfOAuth {
  private readonly key = randomBytes(32);
  private readonly codes = new Map<string, Code>();
  private readonly consents: WindowCounter;

  constructor(private readonly options: SelfOAuthOptions) {
    this.consents = new WindowCounter({ max: 30, windowMs: 60_000 }, options.now);
  }

  /** The OAuth route a path names (synchronous, so the relay dispatches only its own paths here). */
  match(pathname: string): SelfOAuthRoute | undefined {
    for (const pattern of DEVICE_METADATA) {
      const m = pattern.exec(pathname);
      if (m) return { kind: "metadata", device: m[1]! };
    }
    let m: RegExpExecArray | null;
    if ((m = DEVICE_AUTHORIZE.exec(pathname))) return { kind: "authorize", device: m[1]! };
    if ((m = DEVICE_TOKEN.exec(pathname))) return { kind: "token", device: m[1]! };
    if (!this.options.root) return undefined;
    if (pathname === ROOT_METADATA) return { kind: "metadata" };
    if (pathname === ROOT_AUTHORIZE) return { kind: "authorize" };
    if (pathname === ROOT_TOKEN) return { kind: "token" };
    return undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse, route: SelfOAuthRoute): Promise<void> {
    const issuer = this.issuer(route.device);
    if (route.kind === "metadata") return this.metadata(req, res, issuer);
    if (route.kind === "token") return this.token(req, res, issuer);
    if (req.method === "POST") return this.decide(req, res, issuer);
    return this.authorize(req, res, issuer);
  }

  private issuer(device: string | undefined): Issuer {
    const origin = `https://${this.options.relayHost}`;
    return { id: device ? `${origin}/d/${device}` : origin, device };
  }

  /** RFC 8414 authorization server metadata. */
  private async metadata(req: IncomingMessage, res: ServerResponse, issuer: Issuer): Promise<void> {
    this.options.discard(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, PREFLIGHT);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return json(res, 405, { error: "invalid_request" }, { ...CORS, allow: "GET, HEAD, OPTIONS" });
    if (issuer.device !== undefined && !(await this.options.isSelfDevice(issuer.device)))
      return json(res, 404, { error: "not_found" }, CORS);
    json(
      res,
      200,
      {
        issuer: issuer.id,
        authorization_endpoint: `${issuer.id}/oauth/authorize`,
        token_endpoint: `${issuer.id}/oauth/token`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: SELF_OAUTH_SCOPES,
        authorization_response_iss_parameter_supported: true,
      },
      { ...CORS, "cache-control": "max-age=300" },
    );
  }

  private lang(req: IncomingMessage): Lang {
    return /^\s*ru\b/i.test(String(req.headers["accept-language"] ?? "")) ? "ru" : "en";
  }

  /**
   * An HTML page that cannot be framed or run script. The consent page posts its form to the relay
   * itself and then to the redirect target (`formAction`); its referrer policy keeps the `Origin` header
   * of that same-origin POST (the decision requires it) and sends no referrer elsewhere.
   */
  private page(
    res: ServerResponse,
    status: number,
    lang: Lang,
    title: string,
    body: string,
    formAction?: string,
  ): void {
    const html =
      `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)} · CROT</title><style>${STYLE}</style></head><body><main>` +
      `<h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(html)),
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction ?? "'none'"}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": formAction ? "same-origin" : "no-referrer",
    });
    res.end(html);
  }

  /** An error page (never a redirect: the request's redirect URI is not trusted yet). The body is drained. */
  private refusePage(req: IncomingMessage, res: ServerResponse, status: number, code: ErrorCode, device?: string) {
    this.options.discard(req);
    const text = TEXT[this.lang(req)];
    this.options.log({ event: "oauth.authorize", ...(device ? { deviceId: device } : {}), status, code });
    this.page(res, status, this.lang(req), text.errorTitle, `<p>${escapeHtml(text.errors[code])}</p>`);
  }

  /** GET authorize: validate the request, then show the consent page (no redirect without a decision). */
  private async authorize(req: IncomingMessage, res: ServerResponse, issuer: Issuer): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return this.refusePage(req, res, 405, "invalid_request");
    let params: URLSearchParams;
    try {
      params = new URL(req.url ?? "/", `https://${this.options.relayHost}`).searchParams;
    } catch {
      return this.refusePage(req, res, 400, "invalid_request");
    }
    const names = [...params.keys()];
    if (new Set(names).size !== names.length) return this.refusePage(req, res, 400, "invalid_request");
    const device = selfOAuthDevice(params.get("client_id") ?? undefined);
    if (
      !device ||
      (issuer.device !== undefined && device !== issuer.device) ||
      !(await this.options.isSelfDevice(device))
    )
      return this.refusePage(req, res, 400, "unknown_client");
    const redirect = redirectUri(params.get("redirect_uri"));
    if (!redirect) return this.refusePage(req, res, 400, "invalid_redirect", device);
    if (params.get("response_type") !== "code")
      return this.refusePage(req, res, 400, "unsupported_response_type", device);
    const challenge = params.get("code_challenge") ?? undefined;
    const method = params.get("code_challenge_method") ?? undefined;
    if (
      (challenge !== undefined && (method !== "S256" || !CHALLENGE.test(challenge))) ||
      (challenge === undefined && method !== undefined)
    )
      return this.refusePage(req, res, 400, "invalid_pkce", device);
    const scope = params.get("scope") || undefined;
    if (scope !== undefined && !validScope(scope)) return this.refusePage(req, res, 400, "invalid_scope", device);
    const state = params.get("state") ?? undefined;
    if (state !== undefined && state.length > MAX_STATE)
      return this.refusePage(req, res, 400, "invalid_request", device);
    const resource = params.get("resource") ?? undefined;
    if (resource !== undefined && !this.isResource(resource, device))
      return this.refusePage(req, res, 400, "invalid_target", device);
    const pending: Pending = {
      d: device,
      r: params.get("redirect_uri")!,
      i: issuer.id,
      e: this.options.now() + REQUEST_TTL_MS,
      ...(state !== undefined ? { s: state } : {}),
      ...(challenge !== undefined ? { p: challenge } : {}),
      ...(scope !== undefined ? { o: scope } : {}),
    };
    const lang = this.lang(req);
    const text = TEXT[lang];
    const action = new URL(req.url ?? "/", `https://${this.options.relayHost}`).pathname;
    const body =
      `<p>${text.intro(escapeHtml(device), escapeHtml(this.options.relayHost))}</p>` +
      `<dl><dt>${escapeHtml(text.target)}</dt><dd><b>${escapeHtml(redirect.host || redirect.protocol)}</b><br>` +
      `<code>${escapeHtml(redirect.href)}</code></dd>` +
      `<dt>${escapeHtml(text.scope)}</dt><dd><code>${escapeHtml(scope ?? SELF_OAUTH_SCOPES.join(" "))}</code></dd></dl>` +
      `<p class="note">${escapeHtml(text.note)}</p>` +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<input type="hidden" name="request" value="${escapeHtml(this.sign(pending))}">` +
      `<button type="submit" name="decision" value="deny">${escapeHtml(text.deny)}</button>` +
      `<button type="submit" class="allow" name="decision" value="allow">${escapeHtml(text.allow)}</button></form>`;
    this.options.discard(req);
    this.options.log({ event: "oauth.authorize", deviceId: device, status: 200, code: "consent" });
    this.page(res, 200, lang, text.title, body, `'self' ${redirectSource(redirect)}`);
  }

  /** POST authorize: the owner's decision on the consent page; Allow issues a code, Deny an error. */
  private async decide(req: IncomingMessage, res: ServerResponse, issuer: Issuer): Promise<void> {
    let origin: string | undefined;
    try {
      origin = req.headers.origin ? new URL(req.headers.origin).host : undefined;
    } catch {
      origin = undefined;
    }
    if (origin !== this.options.relayHost) return this.refusePage(req, res, 403, "forbidden");
    if (mediaType(req) !== "application/x-www-form-urlencoded")
      return this.refusePage(req, res, 400, "invalid_request");
    const raw = await readForm(req);
    const form = raw === undefined ? undefined : singleValueForm(raw);
    if (!form) return this.refusePage(req, res, 400, "invalid_request");
    const pending = this.verify(form.get("request") ?? "");
    if (!pending || pending.i !== issuer.id) return this.refusePage(req, res, 400, "expired");
    const decision = form.get("decision");
    if (decision !== "allow" && decision !== "deny") return this.refusePage(req, res, 400, "invalid_request");
    if (!(await this.options.isSelfDevice(pending.d))) return this.refusePage(req, res, 400, "unknown_client");
    const target = new URL(pending.r);
    if (decision === "allow") {
      if (this.consents.take(pending.d) !== undefined) return this.refusePage(req, res, 429, "rate_limited", pending.d);
      const code = randomBytes(32).toString("base64url");
      this.store(code, {
        device: pending.d,
        redirect: pending.r,
        challenge: pending.p,
        scope: pending.o,
        expires: this.options.now() + AUTHORIZATION_CODE_TTL_MS,
      });
      target.searchParams.append("code", code);
    } else {
      target.searchParams.append("error", "access_denied");
    }
    if (pending.s !== undefined) target.searchParams.append("state", pending.s);
    target.searchParams.append("iss", pending.i);
    this.options.log({ event: "oauth.authorize", deviceId: pending.d, status: 303, code: decision });
    res.writeHead(303, { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }

  /** POST token: authorization_code (checked here), refresh_token and client_credentials (the device checks). */
  private async token(req: IncomingMessage, res: ServerResponse, issuer: Issuer): Promise<void> {
    let device: string | undefined = issuer.device;
    const fail = (status: number, error: string, code: string, headers: Record<string, string> = {}) => {
      this.options.discard(req);
      this.options.log({ event: "oauth.token", ...(device ? { deviceId: device } : {}), status, code });
      json(res, status, { error }, { ...CORS, ...headers });
    };
    if (req.method === "OPTIONS") {
      this.options.discard(req);
      res.writeHead(204, PREFLIGHT);
      res.end();
      return;
    }
    if (req.method !== "POST") return fail(405, "invalid_request", "method_not_allowed", { allow: "POST, OPTIONS" });
    if (mediaType(req) !== "application/x-www-form-urlencoded") return fail(400, "invalid_request", "content_type");
    const raw = await readForm(req);
    const form = raw === undefined ? undefined : singleValueForm(raw);
    if (!form) return fail(400, "invalid_request", "invalid_body");
    const client = oauthClientCredentials(req.headers.authorization, form);
    if (client === "invalid") return fail(400, "invalid_request", "client_authentication");
    if (!client) return fail(401, "invalid_client", "no_client", BASIC_CHALLENGE);
    const named = selfOAuthDevice(client.id);
    if (!named || (device !== undefined && named !== device) || !(await this.options.isSelfDevice(named)))
      return fail(401, "invalid_client", "unknown_client", BASIC_CHALLENGE);
    device = named;
    const scope = form.get("scope") || undefined;
    if (scope !== undefined && !validScope(scope)) return fail(400, "invalid_scope", "invalid_scope");
    const resource = form.get("resource") ?? undefined;
    if (resource !== undefined && !this.isResource(resource, device))
      return fail(400, "invalid_target", "invalid_target");
    const grant = form.get("grant_type");
    const forwarded = new URLSearchParams();
    if (grant === "authorization_code") {
      const entry = this.take(form.get("code") ?? "");
      if (!entry || entry.device !== device) return fail(400, "invalid_grant", "invalid_code");
      if (form.get("redirect_uri") !== entry.redirect) return fail(400, "invalid_grant", "redirect_mismatch");
      const verifier = form.get("code_verifier") ?? undefined;
      const pkce =
        entry.challenge === undefined
          ? verifier === undefined
          : verifier !== undefined &&
            VERIFIER.test(verifier) &&
            sameBytes(Buffer.from(sha256(verifier).toString("base64url")), Buffer.from(entry.challenge));
      if (!pkce) return fail(400, "invalid_grant", "pkce_mismatch");
      forwarded.set("grant_type", "client_credentials");
      if (entry.scope) forwarded.set("scope", entry.scope);
    } else if (grant === "refresh_token" || grant === "client_credentials") {
      forwarded.set("grant_type", grant);
      if (grant === "refresh_token") {
        const refresh = form.get("refresh_token");
        if (!refresh) return fail(400, "invalid_request", "no_refresh_token");
        forwarded.set("refresh_token", refresh);
      }
      if (scope) forwarded.set("scope", scope);
    } else return fail(400, "unsupported_grant_type", "unsupported_grant_type");
    const authorization =
      "Basic " +
      Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`, "utf8").toString("base64");
    await this.options.forward(req, res, {
      deviceId: device,
      authorization,
      body: Buffer.from(forwarded.toString(), "utf8"),
      clientKey: "oauth:" + sha256(client.secret).toString("hex").slice(0, 16),
    });
  }

  private isResource(resource: string, device: string): boolean {
    return resource.replace(/\/$/, "") === canonicalDeviceUri(this.options.relayHost, device);
  }

  private sign(pending: Pending): string {
    const payload = Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
    return `${payload}.${createHmac("sha256", this.key).update(payload).digest("base64url")}`;
  }

  private verify(value: string): Pending | undefined {
    if (value.length > MAX_FORM_BYTES) return undefined;
    const dot = value.indexOf(".");
    if (dot <= 0) return undefined;
    const payload = value.slice(0, dot);
    const mac = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(createHmac("sha256", this.key).update(payload).digest("base64url"));
    if (!sameBytes(mac, expected)) return undefined;
    try {
      const pending = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Pending;
      return typeof pending.e === "number" && pending.e > this.options.now() ? pending : undefined;
    } catch {
      return undefined;
    }
  }

  private store(code: string, entry: Code): void {
    const now = this.options.now();
    for (const [key, value] of this.codes) if (value.expires <= now) this.codes.delete(key);
    // Bounded: the oldest outstanding code goes first (its client authorizes again).
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    this.codes.set(sha256(code).toString("hex"), entry);
  }

  /** The code's grant, once: a presented code is spent whether or not the request succeeds. */
  private take(code: string): Code | undefined {
    if (!CODE.test(code)) return undefined;
    const key = sha256(code).toString("hex");
    const entry = this.codes.get(key);
    this.codes.delete(key);
    return entry && entry.expires > this.options.now() ? entry : undefined;
  }

  /** Outstanding authorization codes (tests). */
  get outstandingCodes(): number {
    return this.codes.size;
  }
}
