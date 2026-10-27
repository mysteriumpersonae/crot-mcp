/** Mandatory API boundary: generic network tools cannot write to social providers, even in Full Control. */
const HOSTS = [
  "googleapis.com",
  "youtube.com",
  "tiktokapis.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "github.com",
  "notion.com",
  "notion.so",
  "notion.site",
];
export function socialWriteTarget(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>> = {},
  body?: Buffer,
): boolean {
  const overridden =
    Object.keys(headers).some((k) =>
      ["x-http-method-override", "x-http-method", "x-method-override"].includes(k.toLowerCase()),
    ) || ["_method", "_httpMethod", "$httpMethod"].some((k) => url.searchParams.has(k));
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) && !overridden && !body?.length) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return HOSTS.some((s) => host === s || host.endsWith("." + s));
}
