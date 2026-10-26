/** Fixed provider endpoints. No renderer/agent endpoint overrides. Fixtures use a separate trusted factory. */
import {
  AccountAuthorizationError,
  type AccountProfile,
  type OAuthAccountAdapter,
  type OAuthTokens,
  type ProviderClient,
} from "./accounts.js";
import type { SocialProvider } from "./account-secrets.js";
interface Spec {
  authorization: string;
  token: string;
  profile: string;
  revoke: string;
  scopes: string[];
  pkce: boolean;
}
export const SOCIAL_OAUTH_ENDPOINTS: Readonly<Record<SocialProvider, Readonly<Spec>>> = Object.freeze({
  youtube: {
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    profile: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    revoke: "https://oauth2.googleapis.com/revoke",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    pkce: true,
  },
  tiktok: {
    authorization: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    profile: "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
    revoke: "https://open.tiktokapis.com/v2/oauth/revoke/",
    scopes: ["user.info.basic", "video.upload", "video.publish"],
    pkce: true,
  },
  x: {
    authorization: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    profile: "https://api.x.com/2/users/me?user.fields=profile_image_url",
    revoke: "https://api.x.com/2/oauth2/revoke",
    scopes: ["tweet.read", "tweet.write", "media.write", "users.read", "offline.access"],
    pkce: true,
  },
  github: {
    authorization: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    profile: "https://api.github.com/user",
    revoke: "https://api.github.com/applications/",
    scopes: ["read:user", "repo"],
    pkce: true,
  },
  notion: {
    authorization: "https://api.notion.com/v1/oauth/authorize",
    token: "https://api.notion.com/v1/oauth/token",
    profile: "https://api.notion.com/v1/users/me",
    revoke: "https://api.notion.com/v1/oauth/revoke",
    scopes: [],
    pkce: false,
  },
});
interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}
async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<HttpResult> {
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    !(parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"))
  )
    throw new Error("Invalid provider endpoint");
  const response = await fetch(parsed, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (reader)
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 64 * 1024) throw new Error("Provider response exceeded limit");
        chunks.push(r.value);
      }
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: Record<string, unknown> = {};
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value as Record<string, unknown>;
    } catch {
      throw new Error("Invalid provider response");
    }
  }
  return { status: response.status, body };
}
const text = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const basic = (client: ProviderClient) => {
  if (!client.clientSecret) throw new Error("OAuth application secret is required");
  return "Basic " + Buffer.from(client.clientId + ":" + client.clientSecret).toString("base64");
};
function tokens(result: HttpResult): OAuthTokens {
  if (result.status < 200 || result.status >= 300 || result.body.error) {
    if (result.status === 401 || ["invalid_grant", "invalid_token"].includes(String(result.body.error)))
      throw new AccountAuthorizationError("Provider requires account authorization");
    throw new Error("Provider token request failed");
  }
  const access = text(result.body.access_token),
    refresh = text(result.body.refresh_token),
    expiry = result.body.expires_in;
  if (!access || (expiry !== undefined && (!Number.isSafeInteger(expiry) || Number(expiry) <= 0)))
    throw new Error("Invalid provider token response");
  return { access, ...(refresh ? { refresh } : {}), ...(expiry !== undefined ? { expiresIn: Number(expiry) } : {}) };
}
function adapter(provider: SocialProvider, spec: Spec): OAuthAccountAdapter {
  const tokenRequest = async (client: ProviderClient, fields: Record<string, string>, signal: AbortSignal) => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "CROT" };
    let body: string;
    if (provider === "notion") {
      headers.authorization = basic(client);
      headers["content-type"] = "application/json";
      body = JSON.stringify(fields);
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams(fields);
      form.set(provider === "tiktok" ? "client_key" : "client_id", client.clientId);
      if (provider === "x" && client.clientSecret) headers.authorization = basic(client);
      else if (client.clientSecret) form.set("client_secret", client.clientSecret);
      if ((provider === "github" || provider === "tiktok") && !client.clientSecret)
        throw new Error("OAuth application secret is required");
      body = form.toString();
    }
    return tokens(await request(spec.token, { method: "POST", headers, body }, signal));
  };
  return {
    provider,
    authorizationEndpoint: spec.authorization,
    scopes: spec.scopes,
    pkce: spec.pkce,
    ...(provider === "tiktok" ? { clientParameter: "client_key", challengeEncoding: "hex", scopeSeparator: "," } : {}),
    ...(provider === "youtube" ? { authorizationExtra: { access_type: "offline", prompt: "consent" } } : {}),
    exchange: (client, input) =>
      tokenRequest(
        client,
        {
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: input.redirectUri,
        },
        input.signal,
      ),
    refresh: (client, refresh, signal) =>
      tokenRequest(client, { grant_type: "refresh_token", refresh_token: refresh }, signal),
    profile: async (access, signal) => {
      const result = await request(
        spec.profile,
        {
          method: "GET",
          headers: {
            authorization: "Bearer " + access,
            accept: "application/json",
            "user-agent": "CROT",
            ...(provider === "notion" ? { "Notion-Version": "2026-03-11" } : {}),
          },
        },
        signal,
      );
      if (result.status === 401) throw new AccountAuthorizationError("Provider revoked the account token");
      if (result.status < 200 || result.status >= 300)
        throw new Error("Provider profile is unavailable or API access is restricted");
      let p: Record<string, unknown> = result.body,
        profile: AccountProfile;
      if (provider === "youtube") {
        p = obj(Array.isArray(p.items) ? p.items[0] : undefined);
        const snippet = obj(p.snippet);
        profile = {
          id: String(p.id ?? ""),
          handle: text(snippet.customUrl) ?? text(snippet.title) ?? "",
          name: text(snippet.title) ?? "",
          avatar: text(obj(obj(snippet.thumbnails).default).url),
        };
      } else if (provider === "tiktok") {
        p = obj(obj(p.data).user);
        profile = {
          id: text(p.open_id) ?? "",
          handle: text(p.display_name) ?? "",
          name: text(p.display_name) ?? "",
          avatar: text(p.avatar_url),
          restricted: true,
          restriction: "tiktok_private_or_draft_only",
        };
      } else if (provider === "x") {
        p = obj(p.data);
        profile = {
          id: String(p.id ?? ""),
          handle: "@" + (text(p.username) ?? ""),
          name: text(p.name) ?? "",
          avatar: text(p.profile_image_url),
        };
      } else if (provider === "github")
        profile = {
          id: String(p.id ?? ""),
          handle: "@" + (text(p.login) ?? ""),
          name: text(p.name) ?? text(p.login) ?? "",
          avatar: text(p.avatar_url),
        };
      else
        profile = {
          id: text(p.id) ?? "",
          handle: text(p.name) ?? text(obj(p.bot).workspace_name) ?? "Notion workspace",
          name: text(p.name) ?? "Notion workspace",
          avatar: text(p.avatar_url),
        };
      if (profile.avatar) {
        try {
          if (new URL(profile.avatar).protocol !== "https:") delete profile.avatar;
        } catch {
          delete profile.avatar;
        }
      }
      if (!profile.id || !profile.handle || profile.handle === "@")
        throw new Error("Provider did not return a verified account identity");
      return profile;
    },
    revoke: async (client, credential, signal) => {
      const access = credential.access ?? credential.refresh;
      if (!access) return;
      const headers: Record<string, string> = { accept: "application/json", "user-agent": "CROT" };
      let url = spec.revoke,
        body: string,
        method = "POST";
      if (provider === "github") {
        headers.authorization = basic(client);
        headers["content-type"] = "application/json";
        url += encodeURIComponent(client.clientId) + "/token";
        body = JSON.stringify({ access_token: access });
        method = "DELETE";
      } else if (provider === "notion") {
        headers.authorization = basic(client);
        headers["content-type"] = "application/json";
        headers["Notion-Version"] = "2026-03-11";
        body = JSON.stringify({ token: access });
      } else {
        headers["content-type"] = "application/x-www-form-urlencoded";
        const form = new URLSearchParams({ token: provider === "youtube" ? (credential.refresh ?? access) : access });
        if (provider === "tiktok") {
          if (!client.clientSecret) throw new Error("OAuth application secret is required");
          form.set("client_key", client.clientId);
          form.set("client_secret", client.clientSecret);
        }
        if (provider === "x") {
          form.set("client_id", client.clientId);
          if (client.clientSecret) headers.authorization = basic(client);
        }
        body = form.toString();
      }
      const r = await request(url, { method, headers, body }, signal);
      if (provider === "youtube" && r.status === 400 && r.body.error === "invalid_token") return;
      if (r.status < 200 || r.status >= 300 || r.body.error || (provider === "x" && r.body.revoked !== true))
        throw new Error("Provider did not confirm account revocation");
    },
  };
}
export function productionOAuthAdapters(): ReadonlyMap<SocialProvider, OAuthAccountAdapter> {
  const adapters = new Map(
    Object.entries(SOCIAL_OAUTH_ENDPOINTS).map(([p, s]) => [p as SocialProvider, adapter(p as SocialProvider, s)]),
  );
  adapters.set("notion", notionBrokerAdapter());
  return adapters;
}
/** Local fixture endpoints are an in-process test-composition seam, never persisted configuration or an RPC field. */
export function fixtureOAuthAdapter(provider: SocialProvider, origin: string): OAuthAccountAdapter {
  const u = new URL(origin);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new Error("Invalid fixture origin");
  return adapter(provider, {
    ...SOCIAL_OAUTH_ENDPOINTS[provider],
    authorization: origin + "/authorize",
    token: origin + "/token",
    profile: origin + "/profile",
    revoke: origin + "/revoke",
    pkce: true,
  });
}

/** Notion itself does not implement native PKCE; the fixed CROT broker terminates that leg (AD-63). */
export function notionBrokerAdapter(): OAuthAccountAdapter {
  return brokerAdapter("https://mcp.crot.network", SOCIAL_OAUTH_ENDPOINTS.notion.profile);
}
function brokerAdapter(origin: string, profileUrl: string): OAuthAccountAdapter {
  const direct = adapter("notion", { ...SOCIAL_OAUTH_ENDPOINTS.notion, profile: profileUrl });
  const post = (route: string, client: ProviderClient, fields: Record<string, string>, signal: AbortSignal) => {
    if (client.clientId !== "crot-desktop" || client.clientSecret !== undefined)
      throw new Error("Notion uses the registered CROT native client, never a shipped application secret");
    return request(
      origin + "/oauth/notion/" + route,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: client.clientId, ...fields }).toString(),
      },
      signal,
    );
  };
  return {
    provider: "notion",
    pkce: true,
    scopes: [],
    authorizationEndpoint: origin + "/oauth/notion/authorize",
    exchange: async (client, input) =>
      tokens(
        await post(
          "token",
          client,
          {
            grant_type: "authorization_code",
            code: input.code,
            code_verifier: input.verifier,
            redirect_uri: input.redirectUri,
          },
          input.signal,
        ),
      ),
    refresh: async (client, refresh, signal) =>
      tokens(await post("refresh", client, { refresh_token: refresh }, signal)),
    profile: direct.profile,
    revoke: async (client, credential, signal) => {
      const token = credential.refresh ?? credential.access;
      if (!token) return;
      const result = await post("revoke", client, { token }, signal);
      if (result.status !== 200 || result.body.error) throw new Error("Broker did not confirm provider revocation");
    },
  };
}
/** Trusted composition only; cannot be selected through owner/agent configuration. */
export function fixtureNotionBrokerAdapter(origin: string, profileOrigin: string): OAuthAccountAdapter {
  for (const value of [origin, profileOrigin]) {
    const u = new URL(value);
    if (u.origin !== value || u.protocol !== "http:" || u.hostname !== "127.0.0.1")
      throw new Error("Invalid fixture origin");
  }
  return brokerAdapter(origin, profileOrigin + "/profile");
}
