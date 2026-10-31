/** Dedicated desktop login: system browser, loopback-only callback, state + S256 PKCE. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { callbackPage } from "./callback-page.js";
import { createServer } from "node:http";
import { AuthError, validEmail, type Provider } from "./store.js";
import type { AuthEnvironment } from "./config.js";
export interface OAuthProfile {
  subject: string;
  email: string;
  login: string;
  name?: string;
  avatar?: string;
}
const SETTINGS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    profile: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    id: "GOOGLE_CLIENT_ID",
    secret: "GOOGLE_CLIENT_SECRET",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    profile: "https://api.github.com/user",
    scope: "read:user user:email",
    id: "GITHUB_CLIENT_ID",
    secret: "GITHUB_CLIENT_SECRET",
  },
} as const;
export async function providerProfile(
  provider: Provider,
  code: string,
  verifier: string,
  redirectUri: string,
  env: AuthEnvironment,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<OAuthProfile> {
  const cfg = SETTINGS[provider];
  const json = async (url: string, init: RequestInit) => {
    const r = await request(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      redirect: "error",
    });
    if (!r.ok || Number(r.headers.get("content-length")) > 131072) throw new AuthError("OAUTH_FAILED");
    const reader = r.body?.getReader();
    if (!reader) throw new AuthError("OAUTH_FAILED");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 131072) throw new AuthError("OAUTH_FAILED");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const body = new URLSearchParams({
    client_id: env[cfg.id]!,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (env[cfg.secret]) body.set("client_secret", env[cfg.secret]!);
  const token = await json(cfg.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (
    typeof token.access_token !== "string" ||
    token.access_token.length > 8192 ||
    token.error ||
    (token.token_type && token.token_type.toLowerCase() !== "bearer")
  )
    throw new AuthError("OAUTH_FAILED");
  const headers = {
    accept: "application/json",
    authorization: "Bearer " + token.access_token,
    "user-agent": "CROT-Desktop-Auth",
  };
  const p = await json(cfg.profile, { headers });
  let email: unknown = p.email;
  if (provider === "google") {
    if (p.email_verified !== true || typeof p.sub !== "string" || !p.sub) throw new AuthError("OAUTH_PROFILE_INVALID");
  } else {
    const emails = await json("https://api.github.com/user/emails", { headers });
    if (!Array.isArray(emails) || !Number.isSafeInteger(p.id) || p.id <= 0 || typeof p.login !== "string")
      throw new AuthError("OAUTH_PROFILE_INVALID");
    email = (emails.find((e) => e.primary === true && e.verified === true) ?? emails.find((e) => e.verified === true))
      ?.email;
  }
  if (!validEmail(email)) throw new AuthError("OAUTH_EMAIL_UNVERIFIED");
  const avatar = provider === "google" ? p.picture : p.avatar_url;
  return {
    subject: String(provider === "google" ? p.sub : p.id),
    email,
    login: provider === "github" ? p.login : email.split("@")[0],
    ...(typeof p.name === "string" ? { name: p.name.slice(0, 128) } : {}),
    ...(typeof avatar === "string" && /^https:\/\//.test(avatar) ? { avatar } : {}),
  };
}
export async function beginOAuth(
  provider: Provider,
  env: AuthEnvironment,
  openBrowser: (url: string) => Promise<void>,
  accept: (profile: OAuthProfile) => Promise<void>,
) {
  const cfg = SETTINGS[provider];
  if (!env[cfg.id]) throw new AuthError(provider === "google" ? "GOOGLE_NOT_CONFIGURED" : "GITHUB_NOT_CONFIGURED");
  if (!env[cfg.secret]) throw new AuthError(provider === "google" ? "GOOGLE_SECRET_MISSING" : "GITHUB_SECRET_MISSING");
  const port = Number(env.CROT_AUTH_CALLBACK_PORT || "43821");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AuthError("OAUTH_CALLBACK_CONFIG_INVALID");
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  const host = `127.0.0.1:${port}`,
    redirectUri = `http://${host}/oauth/callback`;
  const controller = new AbortController();
  let used = false,
    finished = false,
    resolve!: () => void,
    reject!: (e: Error) => void;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completion.catch(() => undefined);
  const server = createServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  const end = (error?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    controller.abort();
    server.closeAllConnections();
    server.close();
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => end(new AuthError("OAUTH_TIMEOUT")), 300000);
  timer.unref();
  server.on("request", (req, res) => {
    const send = (status: number, text: string, html = false) => {
      const nonce = randomBytes(18).toString("base64");
      res.writeHead(status, {
        "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      });
      res.end(html ? callbackPage(status === 200, /^ru\b/i.test(req.headers["accept-language"] ?? ""), nonce) : text);
    };
    if (
      req.method !== "GET" ||
      req.headers.host !== host ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.origin ||
      !req.url ||
      req.url.length > 8192
    )
      return send(400, "Invalid callback");
    const u = new URL(req.url, redirectUri),
      q = u.searchParams;
    if (u.pathname !== "/oauth/callback") return send(404, "Not found");
    const received = Buffer.from(q.get("state") ?? ""),
      expected = Buffer.from(state);
    if (
      used ||
      finished ||
      q.getAll("state").length !== 1 ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected) ||
      q.getAll("code").length > 1 ||
      q.getAll("error").length > 1
    )
      return send(400, "Invalid OAuth state");
    if (q.has("error")) {
      used = true;
      res.once("finish", () => end(new AuthError("OAUTH_DENIED")));
      send(400, "", true);
      return;
    }
    const code = q.get("code");
    if (!code || code.length > 4096 || /[\r\n\0]/.test(code)) return send(400, "Invalid authorization code");
    used = true;
    void (async () => {
      try {
        const profile = await providerProfile(provider, code, verifier, redirectUri, env, controller.signal);
        if (finished) return;
        await accept(profile);
        if (finished) return;
        res.once("finish", () => end());
        send(200, "", true);
      } catch (e) {
        if (finished) return;
        const error = e instanceof AuthError ? e : new AuthError("OAUTH_FAILED");
        res.once("finish", () => end(error));
        send(400, "", true);
      }
    })();
  });
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", no);
        yes();
      });
    });
    const url = new URL(cfg.authorize);
    for (const [key, value] of Object.entries({
      client_id: env[cfg.id]!,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: cfg.scope,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    await openBrowser(url.href);
  } catch {
    end(new AuthError("OAUTH_BROWSER_OR_PORT_FAILED"));
    throw new AuthError("OAUTH_BROWSER_OR_PORT_FAILED");
  }
  return { completion, cancel: () => end(new AuthError("OAUTH_CANCELLED")) };
}
