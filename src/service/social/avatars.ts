/** Provider-pinned raster avatars. Renderer receives bounded inert data, never a remote URL or bearer. */
import type { SocialProvider } from "./account-secrets.js";
import type { SocialAccount } from "./accounts.js";
const MAX_BYTES = 24_576;
const HOSTS: Record<SocialProvider, readonly string[]> = {
  youtube: ["yt3.ggpht.com", "yt3.googleusercontent.com"],
  tiktok: ["tiktokcdn.com", "tiktokcdn-us.com"],
  x: ["pbs.twimg.com"],
  github: ["avatars.githubusercontent.com"],
  notion: ["notion.so", "notion-static.com"],
};
export function avatarUrl(provider: SocialProvider, input: string): URL | undefined {
  try {
    const u = new URL(input);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || (u.port && u.port !== "443")) return;
    if (!HOSTS[provider].some((host) => u.hostname === host || u.hostname.endsWith("." + host))) return;
    return u;
  } catch {
    return;
  }
}
/** Magic plus bounded dimensions; Content-Type alone is not trusted. */
export function avatarMime(data: Buffer): string | undefined {
  let width = 0,
    height = 0,
    mime: string | undefined;
  if (
    data.length >= 33 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
    mime = "image/png";
  } else if (data.length > 10 && data[0] === 255 && data[1] === 216) {
    let at = 2;
    while (at + 4 <= data.length) {
      if (data[at++] !== 255) break;
      while (data[at] === 255) at++;
      const marker = data[at++];
      if (marker === 218 || marker === 217 || marker === undefined || at + 2 > data.length) break;
      const length = data.readUInt16BE(at);
      if (length < 2 || at + length > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        height = data.readUInt16BE(at + 3);
        width = data.readUInt16BE(at + 5);
        mime = "image/jpeg";
        break;
      }
      at += length;
    }
  } else if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      width = 1 + data.readUIntLE(24, 3);
      height = 1 + data.readUIntLE(27, 3);
    } else if (chunk === "VP8 " && data.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = data.readUInt16LE(26) & 16383;
      height = data.readUInt16LE(28) & 16383;
    } else if (chunk === "VP8L" && data[20] === 47) {
      const bits = data.readUInt32LE(21);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
    mime = "image/webp";
  }
  return width > 0 && height > 0 && width <= 2048 && height <= 2048 ? mime : undefined;
}
export class AccountAvatars {
  private readonly cache = new Map<string, { data?: string; expires: number }>();
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private readonly abort = new AbortController();
  /** Fetch injection is trusted in-process fixture composition only. URL validation still runs first. */
  constructor(private readonly request: typeof fetch = fetch) {}
  clear() {
    this.cache.clear();
  }
  close() {
    this.abort.abort();
    this.cache.clear();
  }
  async get(account: SocialAccount): Promise<{ ok: true; data?: string }> {
    if (this.abort.signal.aborted || !["connected", "restricted"].includes(account.state) || !account.avatar)
      return { ok: true };
    const u = avatarUrl(account.provider, account.avatar);
    if (!u) return { ok: true };
    const key = JSON.stringify([account.provider, account.id, account.generation, u.href]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return { ok: true, ...(cached.data ? { data: cached.data } : {}) };
    let job = this.pending.get(key);
    if (!job) {
      if (this.pending.size >= 4) return { ok: true };
      job = this.load(u);
      this.pending.set(key, job);
    }
    const data = await job;
    this.pending.delete(key);
    if (this.abort.signal.aborted) return { ok: true };
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { data, expires: Date.now() + (data ? 300_000 : 30_000) });
    return { ok: true, ...(data ? { data } : {}) };
  }
  private async load(url: URL): Promise<string | undefined> {
    try {
      const response = await this.request(url, {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
      });
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (
        !response.ok ||
        !response.body ||
        !["image/png", "image/jpeg", "image/webp"].includes(type ?? "") ||
        Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
      ) {
        await response.body?.cancel();
        return;
      }
      const reader = response.body.getReader(),
        chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            return;
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        reader.releaseLock();
      }
      const data = Buffer.concat(chunks),
        detected = avatarMime(data);
      if (!detected || detected !== type) return;
      return `data:${detected};base64,${data.toString("base64")}`;
    } catch {
      return;
    }
  }
}
