/**
 * The client credential of an MCP request, in each form MCP clients offer (Notion Custom MCP, n8n,
 * Claude and others):
 * - `Authorization: Bearer <token>`;
 * - `Authorization: Basic base64(user:password)`: the password, or the user name when the password
 *   is empty (`crot:<token>` and `<token>:` both carry the token);
 * - an API-key header: `X-API-Key`, `Api-Key` or `X-CROT-Token` (a pasted `Bearer ` prefix is ignored).
 *
 * Every form carries the same token, which the verifier then checks exactly as a Bearer token
 * (SHA-256 digest of the client token). A request that repeats a credential header, presents a
 * malformed value or presents two different credentials is refused as malformed. Paired relay
 * requests (OAuth access tokens, AD-21) keep the Bearer form only (`bearerOnly`).
 */
export const API_KEY_HEADERS: readonly string[] = Object.freeze(["x-api-key", "api-key", "x-crot-token"]);

export type CredentialScheme = "bearer" | "basic" | "api-key";
export type PresentedCredential =
  { readonly token: string; readonly scheme: CredentialScheme } | "missing" | "malformed";

/** Visible ASCII only; long enough for a JWT access token, short enough to stay inside one header. */
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function basicToken(value: string): string | undefined {
  if (!BASE64.test(value)) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"));
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  const user = colon < 0 ? decoded : decoded.slice(0, colon);
  const password = colon < 0 ? "" : decoded.slice(colon + 1);
  const token = password || user;
  return TOKEN.test(token) ? token : undefined;
}

function authorizationToken(value: string, bearerOnly: boolean): { token: string; scheme: CredentialScheme } | null {
  const m = /^([A-Za-z]+) +(\S+) *$/.exec(value);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "bearer") return TOKEN.test(m[2]!) ? { token: m[2]!, scheme: "bearer" } : null;
  if (scheme === "basic" && !bearerOnly) {
    const token = basicToken(m[2]!);
    return token ? { token, scheme: "basic" } : null;
  }
  return null;
}

/** The credential of a request from its raw headers (`IncomingMessage.rawHeaders` or a header list). */
export function presentedCredential(
  rawHeaders: readonly string[],
  options: { readonly bearerOnly?: boolean } = {},
): PresentedCredential {
  const bearerOnly = options.bearerOnly === true;
  const authorization: string[] = [];
  const keys = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (name === "authorization") authorization.push(rawHeaders[i + 1]!);
    else if (!bearerOnly && API_KEY_HEADERS.includes(name))
      keys.set(name, [...(keys.get(name) ?? []), rawHeaders[i + 1]!]);
  }
  const found: { token: string; scheme: CredentialScheme }[] = [];
  if (authorization.length > 1) return "malformed";
  if (authorization.length === 1) {
    const parsed = authorizationToken(authorization[0]!.trim(), bearerOnly);
    if (!parsed) return "malformed";
    found.push(parsed);
  }
  for (const values of keys.values()) {
    if (values.length > 1) return "malformed";
    const token = values[0]!.trim().replace(/^bearer +/i, "");
    if (!TOKEN.test(token)) return "malformed";
    found.push({ token, scheme: "api-key" });
  }
  if (found.length === 0) return "missing";
  if (new Set(found.map((f) => f.token)).size > 1) return "malformed";
  return found[0]!;
}

/** OAuth client id of a self-registered device's relay URL: `crot-<deviceId>` (the bare id is accepted too). */
export const selfOAuthClientId = (deviceId: string): string => `crot-${deviceId}`;

/** The device a self-OAuth client id names, or undefined. */
export function selfOAuthDevice(clientId: string | undefined): string | undefined {
  const m = /^(?:crot-)?([a-z2-7]{26})$/.exec(clientId ?? "");
  return m ? m[1] : undefined;
}

const formDecode = (value: string): string => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
};

/**
 * OAuth client authentication of a token request (RFC 6749 section 2.3.1): `client_secret_basic`
 * (`Authorization: Basic base64(urlencode(id):urlencode(secret))`) or `client_secret_post`
 * (`client_id` and `client_secret` form parameters), never both. "invalid": malformed or both.
 */
export function oauthClientCredentials(
  authorization: string | undefined,
  form: URLSearchParams,
): { readonly id: string; readonly secret: string } | "invalid" | undefined {
  const postId = form.get("client_id") ?? undefined,
    postSecret = form.get("client_secret") ?? undefined;
  if (authorization !== undefined) {
    const m = /^Basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(authorization.trim());
    if (!m || postSecret !== undefined) return "invalid";
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(m[1]!, "base64"));
    } catch {
      return "invalid";
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) return "invalid";
    const id = formDecode(decoded.slice(0, colon)),
      secret = formDecode(decoded.slice(colon + 1));
    if (!id || !secret || (postId !== undefined && postId !== id)) return "invalid";
    return { id, secret };
  }
  if (postId === undefined || postSecret === undefined) return undefined;
  return postId && postSecret ? { id: postId, secret: postSecret } : "invalid";
}

/** A form body (`application/x-www-form-urlencoded`) with each parameter at most once, or undefined. */
export function singleValueForm(body: string): URLSearchParams | undefined {
  const form = new URLSearchParams(body);
  const names = [...form.keys()];
  return new Set(names).size === names.length ? form : undefined;
}
