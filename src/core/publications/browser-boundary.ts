/** System boundary shared with the extension. Owner tab policy cannot override it.
 * This is a route guard, not a network firewall for arbitrary child processes.
 */
export function publicationBrowserTarget(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const is = (domain: string) => host === domain || host.endsWith("." + domain);
  const supported = [
    "youtube.com",
    "googleapis.com",
    "google.com",
    "tiktok.com",
    "tiktokapis.com",
    "x.com",
    "twitter.com",
    "github.com",
    "githubusercontent.com",
    "notion.com",
    "notion.so",
    "crot.network",
  ].some(is);
  if (!supported) return false;
  // Decode repeatedly so percent-encoded separators and double encoding do not
  // turn a protected endpoint into an apparently harmless path. Ambiguity on a
  // provider origin is refused, never interpreted differently by the browser.
  let route = url.pathname;
  for (let i = 0; i < 8; i++) {
    try {
      const decoded = decodeURIComponent(route);
      if (decoded === route) break;
      route = decoded;
    } catch {
      return true;
    }
    if (i === 7 && /%[a-f0-9]{2}/i.test(route)) return true;
  }
  route = route
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  // Normalize decoded dot segments as well as WHATWG's literal normalization.
  const segments: string[] = [];
  for (const part of route.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  route = "/" + segments.join("/");
  if (host === "studio.youtube.com" || host.endsWith(".studio.youtube.com")) return true;
  if (is("youtube.com") && /^\/(?:upload|signin|oauth)/.test(route)) return true;
  if (is("googleapis.com") && (/^\/upload\/youtube/.test(route) || /\/oauth|^\/(?:token|revoke)/.test(route)))
    return true;
  if (host === "accounts.google.com" || host === "oauth2.googleapis.com") return true;
  if (is("tiktokapis.com")) return true;
  if (is("tiktok.com") && /^\/(?:upload|creator-center|tiktokstudio|v2\/auth|oauth|login)/.test(route)) return true;
  if (
    (is("x.com") || is("twitter.com")) &&
    (/^\/(?:compose|i\/oauth|i\/flow\/login|login|oauth)/.test(route) ||
      /^\/(?:\d+\/)?(?:tweets|oauth|media)/.test(route))
  )
    return true;
  if (
    is("github.com") &&
    (/^\/login(?:\/|$)/.test(route) || /^\/(?:applications|app|settings\/applications)/.test(route))
  )
    return true;
  if ((is("notion.com") || is("notion.so")) && /^\/(?:v1\/oauth|oauth|login)/.test(route)) return true;
  return is("crot.network") && /^\/oauth(?:\/|$)/.test(route);
}

/** A SPA can show a composer without changing /home. Social-origin input is
 * owner-only; public profile/video reading and unrelated-site automation remain available. */
export function publicationBrowserControlTarget(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return ["youtube.com", "googleapis.com", "tiktok.com", "tiktokapis.com", "x.com", "twitter.com"].some(
      (domain) => host === domain || host.endsWith("." + domain),
    );
  } catch {
    return false;
  }
}
