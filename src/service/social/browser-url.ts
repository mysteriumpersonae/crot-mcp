/** Independent Electron-main validation. Renderer cannot supply an arbitrary browser destination. */
const routes = {
  youtube: "https://accounts.google.com/o/oauth2/v2/auth",
  tiktok: "https://www.tiktok.com/v2/auth/authorize/",
  x: "https://x.com/i/oauth2/authorize",
  github: "https://github.com/login/oauth/authorize",
  notion: "https://mcp.crot.network/oauth/notion/authorize",
} as const;
export function socialAuthorizationUrl(provider: string, value: unknown): string | undefined {
  if (!Object.hasOwn(routes, provider) || typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const u = new URL(value),
      route = routes[provider as keyof typeof routes];
    if (u.origin + u.pathname !== route || u.username || u.password || u.hash || u.protocol !== "https:")
      return undefined;
    for (const key of new Set(u.searchParams.keys())) if (u.searchParams.getAll(key).length !== 1) return undefined;
    if (
      u.searchParams.get("response_type") !== "code" ||
      u.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("state") ?? "") ||
      !(provider === "tiktok" ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{43}$/).test(
        u.searchParams.get("code_challenge") ?? "",
      )
    )
      return undefined;
    const callback = new URL(u.searchParams.get("redirect_uri") ?? "");
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      !callback.port ||
      Number(callback.port) < 1 ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      !/^\/oauth\/callback\/[A-Za-z0-9_-]{43}$/.test(callback.pathname)
    )
      return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}
