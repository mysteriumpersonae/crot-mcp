/**
 * The relay-side OAuth of self-registered devices (src/cloud-relay/self-oauth.ts): discovery, the owner's
 * consent, single-use PKCE-bound authorization codes and the token requests forwarded to the device.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { oauthClientCredentials } from "../../src/adapters/http/credentials.js";
import {
  AUTHORIZATION_CODE_TTL_MS,
  SelfOAuth,
  type ForwardedTokenRequest,
  type SelfOAuthOptions,
} from "../../src/cloud-relay/self-oauth.js";
import { generateDeviceId } from "../../src/identity/device-id.js";

const HOST = "relay.crot-dev.example";
const ORIGIN = `https://${HOST}`;
const REDIRECT = "https://client.example/oauth/callback";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

async function harness(options: Partial<SelfOAuthOptions> = {}) {
  let time = Date.now();
  const devices = new Set<string>();
  const forwarded: ForwardedTokenRequest[] = [];
  const logs: { event: string; deviceId?: string; status: number; code: string }[] = [];
  const oauth = new SelfOAuth({
    relayHost: HOST,
    root: true,
    now: () => time,
    isSelfDevice: async (id) => devices.has(id),
    forward: async (req, res, t) => {
      forwarded.push(t);
      req.resume();
      const body = JSON.stringify({ access_token: "crot_at_device", token_type: "Bearer" });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(body);
    },
    discard: (req) => void req.resume(),
    log: (record) => logs.push(record),
    ...options,
  });
  const server = createServer((req, res) => {
    const route = oauth.match((req.url ?? "").split("?")[0]!);
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    void oauth.handle(req, res, route);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const send = (method: string, p: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: p,
          headers: {
            host: HOST,
            ...(body !== undefined
              ? {
                  "content-type": "application/x-www-form-urlencoded",
                  "content-length": String(Buffer.byteLength(body)),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
        },
      );
      req.once("error", reject);
      req.end(body);
    });
  const device = generateDeviceId();
  devices.add(device);
  return { oauth, devices, forwarded, logs, send, device, advance: (ms: number) => (time += ms) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
const consentRequest = (html: string) => /name="request" value="([^"]+)"/.exec(html)?.[1];

/** GET authorize → consent page → the owner's decision; the 303 redirect target. */
async function consent(
  h: Awaited<ReturnType<typeof harness>>,
  params: Record<string, string>,
  decision: "allow" | "deny" = "allow",
  base = `/d/${h.device}`,
): Promise<URL> {
  const page = await h.send("GET", `${base}/oauth/authorize?${query(params)}`);
  expect(page.status).toBe(200);
  const signed = consentRequest(page.text)!;
  const decided = await h.send("POST", `${base}/oauth/authorize`, query({ request: signed, decision }), {
    origin: ORIGIN,
  });
  expect(decided.status).toBe(303);
  return new URL(String(decided.headers.location));
}

describe("SelfOAuth discovery", () => {
  it("routes device and relay-wide endpoints and serves RFC 8414 metadata for self devices only", async () => {
    const h = await harness();
    const id = h.device;
    expect(h.oauth.match(`/.well-known/oauth-authorization-server/d/${id}`)).toEqual({ kind: "metadata", device: id });
    expect(h.oauth.match(`/d/${id}/.well-known/oauth-authorization-server`)).toEqual({ kind: "metadata", device: id });
    expect(h.oauth.match(`/d/${id}/oauth/authorize`)).toEqual({ kind: "authorize", device: id });
    expect(h.oauth.match(`/d/${id}/oauth/token`)).toEqual({ kind: "token", device: id });
    expect(h.oauth.match("/.well-known/oauth-authorization-server")).toEqual({ kind: "metadata" });
    expect(h.oauth.match("/oauth/token")).toEqual({ kind: "token" });
    for (const other of [`/d/${id}/mcp`, `/d/${id}/oauth/register`, "/d/short/oauth/token", "/oauth"])
      expect(h.oauth.match(other)).toBeUndefined();
    const paired = await harness({ root: false });
    expect(paired.oauth.match("/.well-known/oauth-authorization-server")).toBeUndefined();
    expect(paired.oauth.match("/oauth/authorize")).toBeUndefined();
    expect(paired.oauth.match(`/d/${id}/oauth/token`)).toEqual({ kind: "token", device: id });

    for (const p of [
      `/.well-known/oauth-authorization-server/d/${id}`,
      `/d/${id}/.well-known/oauth-authorization-server`,
    ]) {
      const meta = await h.send("GET", p);
      expect(meta.status).toBe(200);
      expect(meta.headers["access-control-allow-origin"]).toBe("*");
      expect(JSON.parse(meta.text)).toEqual({
        issuer: `${ORIGIN}/d/${id}`,
        authorization_endpoint: `${ORIGIN}/d/${id}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/d/${id}/oauth/token`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    const root = JSON.parse((await h.send("GET", "/.well-known/oauth-authorization-server")).text);
    expect(root).toMatchObject({ issuer: ORIGIN, token_endpoint: `${ORIGIN}/oauth/token` });
    expect((await h.send("GET", `/.well-known/oauth-authorization-server/d/${generateDeviceId()}`)).status).toBe(404);
    const preflight = await h.send("OPTIONS", `/.well-known/oauth-authorization-server/d/${id}`);
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect((await h.send("POST", `/.well-known/oauth-authorization-server/d/${id}`, "")).status).toBe(405);
  });
});

describe("SelfOAuth authorization endpoint", () => {
  it("refuses invalid requests with an error page and never redirects", async () => {
    const h = await harness();
    const { challenge } = pkce();
    const good = {
      client_id: `crot-${h.device}`,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const refused: [Record<string, string | undefined>, string][] = [
      [{ client_id: undefined }, "OAuth Client ID must be crot-"],
      [{ client_id: `crot-${generateDeviceId()}` }, "OAuth Client ID must be crot-"],
      [{ redirect_uri: undefined }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: "http://client.example/cb" }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: "javascript:alert(1)" }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: "data:text/html,hi" }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: `${REDIRECT}#frag` }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: "https://user:pw@client.example/cb" }, "redirect URL is missing or not allowed"],
      [{ redirect_uri: `https://client.example/${"x".repeat(2048)}` }, "redirect URL is missing or not allowed"],
      [{ response_type: "token" }, "response_type=code"],
      [{ code_challenge_method: "plain" }, "PKCE must use the S256"],
      [{ code_challenge_method: undefined }, "PKCE must use the S256"],
      [{ code_challenge: "short" }, "PKCE must use the S256"],
      [{ code_challenge: undefined }, "PKCE must use the S256"],
      [{ scope: 'a"b' }, "requested scope is not valid"],
      [{ state: "s".repeat(1025) }, "malformed"],
      [{ resource: `https://${HOST}/d/${generateDeviceId()}/mcp` }, "resource is not this device"],
    ];
    for (const [change, message] of refused) {
      const params = Object.fromEntries(
        Object.entries({ ...good, ...change }).filter((e): e is [string, string] => e[1] !== undefined),
      );
      const page = await h.send("GET", `/d/${h.device}/oauth/authorize?${query(params)}`);
      expect(page.status, JSON.stringify(change)).toBe(400);
      expect(page.headers.location).toBeUndefined();
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(page.headers["content-security-policy"]).toContain("form-action 'none'");
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.text).toContain(message);
    }
    // A repeated parameter, a client of another device at this device's issuer, and Russian pages.
    const repeated = await h.send("GET", `/d/${h.device}/oauth/authorize?${query(good)}&state=a&state=b`);
    expect(repeated.status).toBe(400);
    const other = generateDeviceId();
    h.devices.add(other);
    const foreign = await h.send(
      "GET",
      `/d/${h.device}/oauth/authorize?${query({ ...good, client_id: `crot-${other}` })}`,
    );
    expect(foreign.status).toBe(400);
    const ru = await h.send("GET", `/d/${h.device}/oauth/authorize?response_type=code`, undefined, {
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.5",
    });
    expect(ru.text).toContain("OAuth Client ID должен быть crot-");
    expect(h.logs.every((l) => l.event === "oauth.authorize")).toBe(true);
  });

  it("shows a consent page that cannot be framed and posts only to itself and the redirect target", async () => {
    const h = await harness();
    const { challenge } = pkce();
    const params = {
      client_id: `crot-${h.device}`,
      redirect_uri: `${REDIRECT}?from=<b>`,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: '"><script>alert(1)</script>',
      scope: "mcp",
      resource: `https://${HOST}/d/${h.device}/mcp`,
    };
    const page = await h.send("GET", `/d/${h.device}/oauth/authorize?${query(params)}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://client.example; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("Allow access to your CROT device?");
    expect(page.text).toContain(`<code>${h.device}</code>`);
    expect(page.text).not.toContain("<script");
    expect(page.text).toContain(`action="/d/${h.device}/oauth/authorize"`);
    expect(consentRequest(page.text)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Loopback and private-use redirect targets (desktop clients, RFC 8252).
    for (const [redirect, source] of [
      ["http://127.0.0.1:33418/callback", "http://127.0.0.1:33418"],
      ["http://localhost:6274/oauth/callback", "http://localhost:6274"],
      ["cursor://anysphere.cursor-retrieval/oauth/callback", "cursor:"],
    ]) {
      const loop = await h.send(
        "GET",
        `/d/${h.device}/oauth/authorize?${query({ ...params, redirect_uri: redirect! })}`,
      );
      expect(loop.status, redirect).toBe(200);
      expect(loop.headers["content-security-policy"]).toContain(`form-action 'self' ${source};`);
    }
    const ru = await h.send("GET", `/d/${h.device}/oauth/authorize?${query(params)}`, undefined, {
      "accept-language": "ru",
    });
    expect(ru.text).toContain("Разрешить доступ к вашему устройству CROT?");
  });

  it("issues a code only on the owner's Allow from the consent page itself", async () => {
    const h = await harness();
    const { challenge } = pkce();
    const params = {
      client_id: `crot-${h.device}`,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-1",
    };
    const page = await h.send("GET", `/d/${h.device}/oauth/authorize?${query(params)}`);
    const signed = consentRequest(page.text)!;
    const allow = query({ request: signed, decision: "allow" });
    const path = `/d/${h.device}/oauth/authorize`;
    // Cross-site or Origin-less posts, other bodies, forged and foreign requests.
    expect((await h.send("POST", path, allow)).status).toBe(403);
    expect((await h.send("POST", path, allow, { origin: "https://evil.example" })).status).toBe(403);
    expect((await h.send("POST", path, allow, { origin: "null" })).status).toBe(403);
    expect(
      (
        await h.send("POST", path, JSON.stringify({ request: signed }), {
          origin: ORIGIN,
          "content-type": "application/json",
        })
      ).status,
    ).toBe(400);
    const forged = signed.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(
      (await h.send("POST", path, query({ request: forged, decision: "allow" }), { origin: ORIGIN })).text,
    ).toContain("This page has expired");
    expect((await h.send("POST", "/oauth/authorize", allow, { origin: ORIGIN })).status).toBe(400);
    expect((await h.send("POST", path, query({ request: signed, decision: "maybe" }), { origin: ORIGIN })).status).toBe(
      400,
    );
    expect((await h.send("POST", path, `${allow}&decision=allow`, { origin: ORIGIN })).status).toBe(400);
    expect(h.oauth.outstandingCodes).toBe(0);

    // Deny: back to the client with access_denied.
    const denied = new URL(
      String(
        (await h.send("POST", path, query({ request: signed, decision: "deny" }), { origin: ORIGIN })).headers.location,
      ),
    );
    expect(`${denied.origin}${denied.pathname}`).toBe(REDIRECT);
    expect(Object.fromEntries(denied.searchParams)).toEqual({
      error: "access_denied",
      state: "st-1",
      iss: `${ORIGIN}/d/${h.device}`,
    });
    // Allow: a code with state and iss (RFC 9207).
    const allowed = await h.send("POST", path, allow, { origin: ORIGIN });
    expect(allowed.status).toBe(303);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    const target = new URL(String(allowed.headers.location));
    expect(target.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(target.searchParams.get("iss")).toBe(`${ORIGIN}/d/${h.device}`);
    expect(h.oauth.outstandingCodes).toBe(1);
    // A device that left the relay gets no code; a page older than 15 minutes has expired.
    h.devices.delete(h.device);
    expect((await h.send("POST", path, allow, { origin: ORIGIN })).status).toBe(400);
    h.devices.add(h.device);
    h.advance(15 * 60_000 + 1);
    expect((await h.send("POST", path, allow, { origin: ORIGIN })).text).toContain("This page has expired");
  });

  it("limits authorizations per device", async () => {
    const h = await harness();
    const page = await h.send(
      "GET",
      `/d/${h.device}/oauth/authorize?${query({ client_id: `crot-${h.device}`, redirect_uri: REDIRECT, response_type: "code" })}`,
    );
    const allow = query({ request: consentRequest(page.text)!, decision: "allow" });
    for (let i = 0; i < 30; i++)
      expect((await h.send("POST", `/d/${h.device}/oauth/authorize`, allow, { origin: ORIGIN })).status).toBe(303);
    const limited = await h.send("POST", `/d/${h.device}/oauth/authorize`, allow, { origin: ORIGIN });
    expect(limited.status).toBe(429);
    h.advance(60_000);
    expect((await h.send("POST", `/d/${h.device}/oauth/authorize`, allow, { origin: ORIGIN })).status).toBe(303);
  });
});

describe("SelfOAuth token endpoint", () => {
  it("exchanges a single-use code bound to its device, redirect URI and PKCE verifier", async () => {
    const h = await harness();
    const { verifier, challenge } = pkce();
    const secret = "client-token+with/odd:chars%";
    const params = {
      client_id: `crot-${h.device}`,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
    };
    const tokenPath = `/d/${h.device}/oauth/token`;
    const auth = { authorization: basic(`crot-${h.device}`, secret) };
    const exchange = (code: string, extra: Record<string, string> = {}, headers: Record<string, string> = auth) =>
      h.send(
        "POST",
        tokenPath,
        query({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, ...extra }),
        headers,
      );

    // Wrong redirect URI or verifier: refused, and the code is spent.
    for (const extra of [
      { redirect_uri: "https://client.example/other" },
      { code_verifier: pkce().verifier },
      { code_verifier: "short" },
    ] as Record<string, string>[]) {
      const code = (await consent(h, params)).searchParams.get("code")!;
      const refused = await exchange(code, extra);
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toEqual({ error: "invalid_grant" });
      expect(refused.headers["access-control-allow-origin"]).toBe("*");
      expect((await exchange(code)).status).toBe(400);
    }
    const missing = (await consent(h, params)).searchParams.get("code")!;
    expect(
      (
        await h.send(
          "POST",
          tokenPath,
          query({ grant_type: "authorization_code", code: missing, redirect_uri: REDIRECT }),
          auth,
        )
      ).status,
    ).toBe(400);
    expect(h.forwarded).toHaveLength(0);

    // The right code: forwarded to the device as a client_credentials grant with the client's own secret.
    const code = (await consent(h, params)).searchParams.get("code")!;
    const ok = await exchange(code);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ access_token: "crot_at_device", token_type: "Bearer" });
    expect(h.forwarded).toHaveLength(1);
    const sent = h.forwarded[0]!;
    expect(sent.deviceId).toBe(h.device);
    expect(Object.fromEntries(new URLSearchParams(sent.body.toString()))).toEqual({
      grant_type: "client_credentials",
      scope: "mcp",
    });
    expect(oauthClientCredentials(sent.authorization, new URLSearchParams())).toEqual({
      id: `crot-${h.device}`,
      secret,
    });
    expect(sent.clientKey).toMatch(/^oauth:[a-f0-9]{16}$/);
    expect(sent.clientKey).not.toContain(secret);
    // Single use.
    expect((await exchange(code)).status).toBe(400);
    expect(h.forwarded).toHaveLength(1);
    // client_secret_post at the relay-wide token endpoint works the same way.
    const viaRoot = (await consent(h, params, "allow", "")).searchParams;
    expect(viaRoot.get("iss")).toBe(ORIGIN);
    const posted = await h.send(
      "POST",
      "/oauth/token",
      query({
        grant_type: "authorization_code",
        code: viaRoot.get("code")!,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: `crot-${h.device}`,
        client_secret: secret,
      }),
    );
    expect(posted.status).toBe(200);
    expect(h.forwarded).toHaveLength(2);
    // A code expires after five minutes.
    const late = (await consent(h, params)).searchParams.get("code")!;
    h.advance(AUTHORIZATION_CODE_TTL_MS);
    expect((await exchange(late)).status).toBe(400);
    expect(h.oauth.outstandingCodes).toBe(0);
  });

  it("binds a code to its device and forwards refresh and client_credentials grants as they are", async () => {
    const h = await harness();
    const other = generateDeviceId();
    h.devices.add(other);
    const params = { client_id: `crot-${h.device}`, redirect_uri: REDIRECT, response_type: "code" };
    const code = (await consent(h, params)).searchParams.get("code")!;
    // A code of this device presented by another device's client, at the relay-wide endpoint.
    const stolen = await h.send(
      "POST",
      "/oauth/token",
      query({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
      { authorization: basic(`crot-${other}`, "secret") },
    );
    expect(JSON.parse(stolen.text)).toEqual({ error: "invalid_grant" });
    // Without PKCE, a verifier must not appear either.
    const plain = (await consent(h, params)).searchParams.get("code")!;
    expect(
      (
        await h.send(
          "POST",
          `/d/${h.device}/oauth/token`,
          query({
            grant_type: "authorization_code",
            code: plain,
            redirect_uri: REDIRECT,
            code_verifier: pkce().verifier,
          }),
          { authorization: basic(`crot-${h.device}`, "secret") },
        )
      ).status,
    ).toBe(400);
    const auth = { authorization: basic(`crot-${h.device}`, "secret") };
    const tokenPath = `/d/${h.device}/oauth/token`;
    expect(
      (await h.send("POST", tokenPath, query({ grant_type: "refresh_token", refresh_token: "crot_rt_x" }), auth))
        .status,
    ).toBe(200);
    expect(
      (await h.send("POST", tokenPath, query({ grant_type: "client_credentials", scope: "mcp" }), auth)).status,
    ).toBe(200);
    expect(h.forwarded.map((f) => Object.fromEntries(new URLSearchParams(f.body.toString())))).toEqual([
      { grant_type: "refresh_token", refresh_token: "crot_rt_x" },
      { grant_type: "client_credentials", scope: "mcp" },
    ]);
    // Refusals before anything is forwarded.
    const refusals: [string, string, Record<string, string>, number, string][] = [
      [tokenPath, query({ grant_type: "refresh_token" }), auth, 400, "invalid_request"],
      [tokenPath, query({ grant_type: "password", username: "u", password: "p" }), auth, 400, "unsupported_grant_type"],
      [tokenPath, query({ grant_type: "client_credentials", scope: 'a"b' }), auth, 400, "invalid_scope"],
      [
        tokenPath,
        query({ grant_type: "client_credentials", resource: "https://evil.example/mcp" }),
        auth,
        400,
        "invalid_target",
      ],
      [tokenPath, query({ grant_type: "client_credentials" }), {}, 401, "invalid_client"],
      [
        tokenPath,
        query({ grant_type: "client_credentials" }),
        { authorization: basic(`crot-${other}`, "s") },
        401,
        "invalid_client",
      ],
      [
        `/d/${generateDeviceId()}/oauth/token`,
        query({ grant_type: "client_credentials" }),
        auth,
        401,
        "invalid_client",
      ],
      [tokenPath, query({ grant_type: "client_credentials", client_secret: "s" }), auth, 400, "invalid_request"],
      [
        tokenPath,
        `${query({ grant_type: "client_credentials" })}&grant_type=refresh_token`,
        auth,
        400,
        "invalid_request",
      ],
    ];
    for (const [p, body, headers, status, error] of refusals) {
      const refused = await h.send("POST", p, body, headers);
      expect(refused.status, body).toBe(status);
      expect(JSON.parse(refused.text)).toEqual({ error });
      if (status === 401) expect(refused.headers["www-authenticate"]).toBe('Basic realm="crot"');
    }
    const json = await h.send("POST", tokenPath, "{}", { ...auth, "content-type": "application/json" });
    expect(json.status).toBe(400);
    expect((await h.send("GET", tokenPath)).status).toBe(405);
    expect((await h.send("OPTIONS", tokenPath)).status).toBe(204);
    expect(h.forwarded).toHaveLength(2);
    expect(JSON.stringify(h.logs)).not.toContain("secret");
  });
});
