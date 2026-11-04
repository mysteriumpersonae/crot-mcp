/**
 * Pages the tray UI may open in the user's browser: OpenCode Zen key and install pages and the Official
 * Integrations tiles. Anything else a renderer asks to open (other hosts, http:, credentials, ports) is denied.
 */
const EXTERNAL_HOSTS = new Set(["opencode.ai", "notion.so", "www.notion.so", "claude.ai", "n8n.io", "crot.network"]);

/** The HTTPS URL to open outside the app for a renderer window request, or undefined to only deny it. */
export function externalLink(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return undefined;
  return EXTERNAL_HOSTS.has(parsed.hostname) ? parsed.href : undefined;
}
