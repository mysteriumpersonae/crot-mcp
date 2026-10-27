import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { fixtureNotionOAuthBroker, NotionOAuthBroker } from "../../src/account-service/notion-oauth-broker.js";
import { startOAuthLoopback, type OAuthFlow } from "../../src/service/social/oauth-loopback.js";
import { fixtureNotionBrokerAdapter } from "../../src/service/social/provider-http.js";
const servers: Server[] = [];
let flow: OAuthFlow | undefined;
afterEach(async () => {
  await flow?.cancel();
  flow = undefined;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const random = () => randomBytes(32).toString("base64url");
async function fixture() {
  let upstreamAuthorization: URL | undefined;
  let expired = false;
  let exchanges = 0,
    revocations = 0,
    refreshes = 0;
  const provider = await listen(
    createServer(async (req, res) => {
      const u = new URL(req.url!, "http://127.0.0.1");
      if (u.pathname === "/authorize") {
        upstreamAuthorization = u;
        const next = new URL(u.searchParams.get("redirect_uri")!);
        next.searchParams.set("state", u.searchParams.get("state")!);
        next.searchParams.set("code", "provider-one-use-code");
        res.writeHead(302, { location: next.href }).end();
        return;
      }
      if (u.pathname === "/profile") {
        expect(req.headers.authorization).toBe("Bearer notion-access");
        res.setHeader("content-type", "application/json");
        res.end('{"id":"bot-id","name":"Real fixture workspace"}');
        return;
      }
      let raw = "";
      for await (const b of req) raw += b;
      expect(req.headers.authorization).toBe(
        "Basic " + Buffer.from("registered-app:server-only-secret").toString("base64"),
      );
      const p = JSON.parse(raw) as Record<string, string>;
      if (u.pathname === "/token") {
        if (expired) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end('{"error":"invalid_grant","private":"never-forward-this"}');
          return;
        }
        if (p.grant_type === "refresh_token") {
          expect(p.refresh_token).toBe("notion-refresh");
          refreshes++;
        } else {
          expect(p.code).toBe("provider-one-use-code");
          expect(p.redirect_uri).toBe(upstreamAuthorization?.searchParams.get("redirect_uri"));
          exchanges++;
        }
        expect(p).not.toHaveProperty("code_verifier"); // no claim that upstream supports PKCE
        res.setHeader("content-type", "application/json");
        res.end(
          '{"access_token":"notion-access","refresh_token":"notion-refresh","owner":{"private":"not-forwarded"}}',
        );
        return;
      }
      if (u.pathname === "/revoke") {
        expect(p.token).toBe("notion-refresh");
        revocations++;
        res.setHeader("content-type", "application/json");
        res.end("{}");
        return;
      }
      res.writeHead(404).end();
    }),
  );
  const origin = await listen(
    createServer((req, res) => {
      void broker!.handle(req, res, new URL(req.url!, "http://127.0.0.1").pathname).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    }),
  );
  const broker = fixtureNotionOAuthBroker(
    { publicOrigin: origin, clientId: "registered-app", clientSecret: "server-only-secret" },
    provider,
  );
  return {
    origin,
    provider,
    expire: () => {
      expired = true;
    },
    exchanges: () => exchanges,
    refreshes: () => refreshes,
    revocations: () => revocations,
  };
}
it("three real HTTP servers: native PKCE -> confidential provider -> native callback, refresh and revoke", async () => {
  const f = await fixture();
  const adapter = fixtureNotionBrokerAdapter(f.origin, f.provider);
  let browser = "";
  let result: unknown;
  flow = await startOAuthLoopback({
    authorizationEndpoint: adapter.authorizationEndpoint,
    clientId: "crot-desktop",
    scopes: [],
    allowLoopbackFixture: true,
    openBrowser: async (url) => {
      browser = url;
    },
    exchange: async (input) => {
      result = await adapter.exchange({ clientId: "crot-desktop" }, input);
    },
  });
  const response = await fetch(browser);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("notion-access");
  await flow.completion;
  expect(result).toEqual({ access: "notion-access", refresh: "notion-refresh" });
  expect(f.exchanges()).toBe(1);
  expect(await adapter.profile("notion-access", new AbortController().signal)).toMatchObject({
    id: "bot-id",
    name: "Real fixture workspace",
  });
  expect(
    await adapter.refresh!({ clientId: "crot-desktop" }, "notion-refresh", new AbortController().signal),
  ).toMatchObject({ access: "notion-access" });
  await adapter.revoke(
    { clientId: "crot-desktop" },
    { access: "notion-access", refresh: "notion-refresh" },
    new AbortController().signal,
  );
  expect(f.refreshes()).toBe(1);
  expect(f.revocations()).toBe(1);
  f.expire();
  await expect(
    adapter.refresh!({ clientId: "crot-desktop" }, "notion-refresh", new AbortController().signal),
  ).rejects.toThrow("authorization");
  expect(browser).not.toContain("server-only-secret");
});
it("rejects state, verifier, redirect substitution, replay, Origin and unregistered callbacks before provider I/O", async () => {
  const f = await fixture(),
    verifier = random(),
    state = random();
  const redirect = `http://127.0.0.1:43123/oauth/callback/${random()}`;
  const auth = new URL(f.origin + "/oauth/notion/authorize");
  auth.search = new URLSearchParams({
    client_id: "crot-desktop",
    response_type: "code",
    redirect_uri: redirect,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const first = await fetch(auth, { redirect: "manual" });
  expect(first.status).toBe(302);
  const upstream = await fetch(first.headers.get("location")!, { redirect: "manual" });
  const callback = new URL(upstream.headers.get("location")!);
  const wrong = new URL(callback);
  wrong.searchParams.set("state", random());
  expect((await fetch(wrong)).status).toBe(400);
  const finish = await fetch(callback, { redirect: "manual" });
  expect(finish.status).toBe(302);
  const native = new URL(finish.headers.get("location")!);
  expect(native.searchParams.get("state")).toBe(state);
  expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  const fields = {
    client_id: "crot-desktop",
    grant_type: "authorization_code",
    code: native.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: redirect,
  };
  const post = (values = fields, headers = {}) =>
    fetch(f.origin + "/oauth/notion/token", { method: "POST", headers, body: new URLSearchParams(values) });
  expect((await post({ ...fields, code_verifier: random() })).status).toBe(400);
  expect((await post({ ...fields, redirect_uri: redirect.replace("43123", "43124") })).status).toBe(400);
  expect((await post(fields, { origin: "https://attacker.example" })).status).toBe(400);
  expect(f.exchanges()).toBe(0);
  const ok = await post();
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ access_token: "notion-access", refresh_token: "notion-refresh" });
  expect((await post()).status).toBe(400);
  expect(f.exchanges()).toBe(1);
  for (const bad of ["http://attacker.example/callback", "http://127.0.0.1:43123/wrong", redirect + "?override=1"]) {
    auth.searchParams.set("redirect_uri", bad);
    expect((await fetch(auth, { redirect: "manual" })).status).toBe(400);
  }
});
it("production broker refuses alternate domains and plaintext origins", () => {
  for (const publicOrigin of ["https://mcp.crot.networking", "http://mcp.crot.network", "https://attacker.example"])
    expect(() => new NotionOAuthBroker({ publicOrigin, clientId: "app", clientSecret: "secret" })).toThrow("origin");
});
