/**
 * Owner-approved self-registration: MCP client → relay /d/<id>/mcp with a client token from
 * tokens.issue (Bearer, Basic, an API-key header, or OAuth 2.0 with the token as the client secret)
 * → WebSocket tunnel → CrotService (no pairing, no cloud OAuth).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServeCommand } from "../../src/cli/options.js";
import { CloudRelay } from "../../src/cloud-relay/server.js";
import { MemoryDeviceRegistry } from "../../src/cloud-relay/registry.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { devicePublicKey, selfRegistrationChallenge, signTunnelProof } from "../../src/identity/device-credential.js";
import { deviceIdForPublicKey, generateDeviceId, SELF_RELAY_HOST } from "../../src/identity/device-id.js";
import { createIdentityHttp } from "../../src/identity/http.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { ControlClient } from "../../src/service/control-client.js";
import type { ControlOverview } from "../../src/service/protocol.js";
import { CrotService } from "../../src/service/service.js";
import { checkRelayEndpoint, relayCheckUrl, relayCheckVerdict } from "../../src/tray/relay-check.js";
import { TestAuthorizationServer, TEST_RELAY, PAIRING_CLIENT } from "../identity/test-authorization-server.js";

const as = new TestAuthorizationServer();
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

async function relay(selfRegistration = true, relayHost = TEST_RELAY, log: (event: object) => void = () => undefined) {
  const r = new CloudRelay({
    relayHost,
    issuer: as.issuer,
    pairingClientId: PAIRING_CLIENT,
    environment: "test",
    keys: new IssuerKeySet({ issuer: as.issuer, http: as.http() }),
    registry: new MemoryDeviceRegistry(),
    entitlement: () => "not_entitled",
    selfRegistration,
    log,
  });
  await r.listen({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => r.close());
  return r;
}

function call(port: number, p: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string; session?: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: {
          host: TEST_RELAY,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            text,
            ...(typeof res.headers["mcp-session-id"] === "string" ? { session: res.headers["mcp-session-id"] } : {}),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function selfBody(key = generateKeyPairSync("ed25519").privateKey, id?: string) {
  const publicKey = devicePublicKey(key);
  const deviceId = id ?? deviceIdForPublicKey(publicKey.x);
  const proof = signTunnelProof(key, deviceId, TEST_RELAY, selfRegistrationChallenge(deviceId)).toString("base64url");
  return { deviceId, body: JSON.stringify({ publicKey, proof }) };
}

describe("self-registration endpoint", () => {
  it("binds a key-derived id once; refuses foreign ids, bad proofs and a disabled relay", async () => {
    const r = await relay();
    const ok = selfBody();
    expect((await call(r.port, `/d/${ok.deviceId}/self-register`, ok.body)).status).toBe(201);
    expect((await call(r.port, `/d/${ok.deviceId}/self-register`, ok.body)).status).toBe(200);
    const squat = selfBody(undefined, generateDeviceId());
    expect((await call(r.port, `/d/${squat.deviceId}/self-register`, squat.body)).status).toBe(403);
    const forged = JSON.parse(ok.body) as { proof: string };
    const other = selfBody();
    const bad = JSON.stringify({ ...JSON.parse(other.body), proof: forged.proof });
    expect((await call(r.port, `/d/${other.deviceId}/self-register`, bad)).status).toBe(403);
    const off = await relay(false);
    expect((await call(off.port, `/d/${ok.deviceId}/self-register`, ok.body)).status).toBe(404);
  });
});

describe("Notion-style client → relay → tunnel → CrotService", () => {
  it("initialize and tools/list return 200 with a tokens.issue Bearer; bad tokens get 401", async () => {
    const r = await relay();
    const base = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "crot-self-"));
    cleanup.push(() => rm(base, { recursive: true, force: true }));
    const workspace = path.join(base, "project"),
      stateDir = path.join(base, "s");
    await mkdir(workspace, { recursive: true });
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const started = await CrotService.start({
      command: {
        kind: "serve",
        warnings: [],
        config: {
          workspace: { root: workspace },
          environment: { path: "inherited" },
          secrets: { store: "file" },
          http: { enabled: true, port: 0 },
          audit: { sink: "none" },
          permissions: { mode: "sandbox", capabilities: ["filesystem.read"] },
        } as ServeCommand["config"],
      },
      launch: "managed",
      stateDir,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
      identity: { environment: as.environment(), http: createIdentityHttp({ fetch: globalThis.fetch }) },
      tunnel: {
        url: () => `ws://127.0.0.1:${r.port}/.crot/tunnel`,
        registerOrigin: () => `http://127.0.0.1:${r.port}`,
        selfRelayHost: TEST_RELAY,
        watchIntervalMs: 25,
      },
    });
    if (started === "already_running") throw new Error("already running");
    cleanup.push(() => started.shutdown("test"));
    const control = (await ControlClient.connect({ stateDir, privateFiles }))!;
    cleanup.push(async () => control.close());
    const overview = (await control.request("overview" as never)) as ControlOverview;
    const deviceId = overview.localDeviceId!;
    expect(deviceId).toMatch(/^[a-z2-7]{26}$/);
    await control.request("remote.setMode" as never, { enabled: true } as never);
    const until = Date.now() + 10_000;
    while (r.status().tunnels.ready !== 1) {
      if (Date.now() > until) throw new Error("tunnel not ready");
      await new Promise((res) => setTimeout(res, 50));
    }
    const { token } = (await control.request(
      "tokens.issue" as never,
      {
        name: "Notion",
        ttlSeconds: 3600,
        scopes: ["files"],
      } as never,
    )) as { token: string };
    const mcp = `/d/${deviceId}/mcp`;
    const init = await call(
      r.port,
      mcp,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "notion", version: "1" } },
      }),
      { authorization: `Bearer ${token}` },
    );
    expect(init.status).toBe(200);
    expect(init.text).toContain('"serverInfo"');
    const session = /"protocolVersion":"([^"]+)"/.exec(init.text)?.[1];
    expect(session).toBeDefined();
    const list = await call(r.port, mcp, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": session!,
      ...(init.session ? { "mcp-session-id": init.session } : {}),
    });
    expect(list.status).toBe(200);
    expect(list.text).toContain("fs_read_file");
    const denied = await call(r.port, mcp, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }), {
      authorization: "Bearer not-a-valid-token-0000000000000000000000",
    });
    expect(denied.status).toBe(401);
    expect((await call(r.port, mcp, "{}")).status).toBe(401);
  }, 30_000);
});

/** The tray probe's fetch, sent to the local relay with the public URL's Host header. */
function fetchVia(port: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: url.pathname,
          method: init?.method ?? "GET",
          headers: { ...headers, host: url.host },
        },
        (res) => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, value);
          res.resume();
          resolve(new Response(null, { status: res.statusCode!, headers: out }));
        },
      );
      req.once("error", reject);
      req.end();
    });
  }) as typeof fetch;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** The desktop app's default service: HTTP disabled, identity environment of another relay. */
async function desktopService(
  relayPort: number,
  selfRelayHost: string,
  selfRetry?: { baseMs: number },
  http: { enabled: boolean; port?: number } = { enabled: false },
) {
  const base = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "crot-desk-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "project"),
    stateDir = path.join(base, "s");
  await mkdir(workspace, { recursive: true });
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const started = await CrotService.start({
    command: {
      kind: "serve",
      warnings: [],
      config: {
        workspace: { root: workspace },
        environment: { path: "inherited" },
        secrets: { store: "file" },
        http,
        audit: { sink: "none" },
        permissions: { mode: "sandbox", capabilities: ["filesystem.read"] },
      } as ServeCommand["config"],
    },
    launch: "managed",
    stateDir,
    privateFiles,
    log: () => undefined,
    requestStop: () => undefined,
    // Its relay host (TEST_RELAY) differs from the self-registered tunnel's on purpose.
    identity: { environment: as.environment(), http: createIdentityHttp({ fetch: globalThis.fetch }) },
    tunnel: {
      url: () => `ws://127.0.0.1:${relayPort}/.crot/tunnel`,
      registerOrigin: () => `http://127.0.0.1:${relayPort}`,
      selfRelayHost,
      watchIntervalMs: 25,
      ...(selfRetry ? { selfRetry } : {}),
    },
  });
  if (started === "already_running") throw new Error("already running");
  cleanup.push(() => started.shutdown("test"));
  const control = (await ControlClient.connect({ stateDir, privateFiles }))!;
  cleanup.push(async () => control.close());
  const ask = (method: string, params?: unknown) => control.request(method as never, params as never);
  const overview = async () => (await ask("overview")) as ControlOverview;
  return { ask, overview, deviceId: (await overview()).localDeviceId! };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "notion", version: "1" } },
});

describe("desktop default (HTTP disabled) → crot.network → tunnel → CrotService, and Check tunnel", () => {
  it("registers at the URL's relay on remote mode on, serves issued tokens and checks green only when live", async () => {
    const r = await relay(true, SELF_RELAY_HOST);
    const { ask, overview, deviceId } = await desktopService(r.port, SELF_RELAY_HOST);
    expect(deviceId).toMatch(/^[a-z2-7]{26}$/);
    // Remote mode on (toggle): self-registration and the tunnel follow at once, without HTTP enabled.
    await ask("remote.setMode", { enabled: true });
    await until(() => r.status().tunnels.ready === 1, "tunnel ready");
    await until(async () => (await overview()).remote?.tunnelState === "ready", "overview tunnelState ready");
    // Check tunnel: the service registers again, reconnects and reports the tunnel's state.
    expect(await ask("remote.reconnect")).toMatchObject({ ok: true, tunnel: { state: "ready" } });
    const { token } = (await ask("tokens.issue", { name: "Notion", ttlSeconds: 3600, scopes: ["files"] })) as {
      token: string;
    };
    const mcp = `/d/${deviceId}/mcp`;
    const init = await call(r.port, mcp, INITIALIZE, { host: SELF_RELAY_HOST, authorization: `Bearer ${token}` });
    expect(init.status).toBe(200);
    expect(init.text).toContain('"serverInfo"');
    expect(
      (await call(r.port, mcp, INITIALIZE, { host: SELF_RELAY_HOST, authorization: "Bearer not-a-valid-token-000000" }))
        .status,
    ).toBe(401);
    // The tray's probe of the URL it shows: the device's own 401 for a throwaway token = live.
    const url = `https://${SELF_RELAY_HOST}${mcp}`;
    expect(relayCheckUrl({ localDeviceId: deviceId })).toBe(url);
    expect(relayCheckVerdict(await checkRelayEndpoint(url, fetchVia(r.port)), { state: "ready" })).toEqual({
      state: "live",
      status: 401,
      tunnel: "ready",
    });
    // A device the relay does not know, and this device with remote mode off: never green.
    const unknown = `https://${SELF_RELAY_HOST}/d/${generateDeviceId()}/mcp`;
    expect(await checkRelayEndpoint(unknown, fetchVia(r.port))).toEqual({ state: "unregistered", status: 404 });
    await ask("remote.setMode", { enabled: false });
    await until(() => r.status().tunnels.ready === 0, "tunnel closed");
    expect(await checkRelayEndpoint(url, fetchVia(r.port))).toEqual({ state: "tunnel_inactive", status: 503 });
    expect((await overview()).remote?.tunnelState).toBe("stopped");
  }, 30_000);

  it("reports a refused registration, retries with backoff and registers again when the owner checks", async () => {
    const events: { event?: string; status?: number }[] = [];
    const r = await relay(true, SELF_RELAY_HOST, (e) => events.push(e as (typeof events)[number]));
    // A proof for another relay host (the old identity-environment host) is refused by this relay.
    const { ask, overview, deviceId } = await desktopService(r.port, "relay-staging.crot.network", {
      baseMs: 60_000,
    });
    const attempts = () => events.filter((e) => e.event === "device.self_register").length;
    await ask("remote.setMode", { enabled: true });
    await until(async () => (await overview()).remote?.tunnelState === "waiting", "registration failure reported");
    expect((await overview()).remote?.tunnel).toContain("The relay did not register this device (refused_403)");
    // The watcher (every 25 ms here) waits for the retry delay instead of hammering the relay.
    const after = attempts();
    expect(after).toBe(1);
    await new Promise((res) => setTimeout(res, 400));
    expect(attempts()).toBe(after);
    // Check tunnel forces a new registration at once and reports the failure (no green state).
    expect(await ask("remote.reconnect")).toMatchObject({
      ok: true,
      tunnel: { state: "waiting", reason: "refused_403" },
    });
    expect(attempts()).toBe(after + 1);
    expect(r.status().tunnels.ready).toBe(0);
    const url = `https://${SELF_RELAY_HOST}/d/${deviceId}/mcp`;
    expect(
      relayCheckVerdict(await checkRelayEndpoint(url, fetchVia(r.port)), { state: "waiting", reason: "refused_403" }),
    ).toEqual({ state: "unregistered", status: 404, tunnel: "waiting" });
  }, 30_000);
});

/** Any request to the local relay with the public URL's Host header; the full response. */
function send(port: number, method: string, p: string, body: string | undefined, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: { ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers },
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
}

const basicAuth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("every MCP authorization method: client → relay /d/<id>/mcp → tunnel → CrotService", () => {
  it.each([
    ["desktop default (HTTP disabled)", { enabled: false }],
    ["HTTP enabled", { enabled: true, port: 0 }],
  ])(
    "%s: Bearer, Basic, API-key headers and OAuth 2.0 reach the device; wrong credentials get 401",
    async (_, http) => {
      const events: object[] = [];
      const r = await relay(true, SELF_RELAY_HOST, (e) => events.push(e));
      const { ask, deviceId } = await desktopService(r.port, SELF_RELAY_HOST, undefined, http);
      await ask("remote.setMode", { enabled: true });
      await until(() => r.status().tunnels.ready === 1, "tunnel ready");
      const issued = (await ask("tokens.issue", { name: "Claude", ttlSeconds: 3600, scopes: ["files"] })) as {
        id: string;
        token: string;
      };
      const token = issued.token;
      const host = { host: SELF_RELAY_HOST };
      const mcp = `/d/${deviceId}/mcp`;
      const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const initialize = (headers: Record<string, string>) =>
        send(r.port, "POST", mcp, INITIALIZE, { ...host, ...json, ...headers });

      // Bearer, Basic (crot:<token> or <token>:) and the API-key headers carry the same client token.
      for (const headers of [
        { authorization: `Bearer ${token}` },
        { authorization: basicAuth("crot", token) },
        { authorization: basicAuth(token, "") },
        { "x-api-key": token },
        { "api-key": token },
        { "x-crot-token": token },
      ] as Record<string, string>[]) {
        const init = await initialize(headers);
        expect(init.status, Object.keys(headers).join()).toBe(200);
        expect(init.text).toContain('"serverInfo"');
      }
      // A tool listing in an API-key session.
      const session = await initialize({ "x-api-key": token });
      const version = /"protocolVersion":"([^"]+)"/.exec(session.text)![1]!;
      const sessionId = session.headers["mcp-session-id"];
      const list = await send(r.port, "POST", mcp, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {
        ...host,
        ...json,
        "x-api-key": token,
        "mcp-protocol-version": version,
        ...(typeof sessionId === "string" ? { "mcp-session-id": sessionId } : {}),
      });
      expect(list.status).toBe(200);
      expect(list.text).toContain("fs_read_file");
      const wrong = "wrong-token-00000000000000000000000000";
      for (const headers of [
        { authorization: `Bearer ${wrong}` },
        { authorization: basicAuth("crot", wrong) },
        { "x-api-key": wrong },
        { "api-key": wrong },
        { authorization: `Bearer ${token}`, "x-api-key": wrong },
        {},
      ] as Record<string, string>[])
        expect((await initialize(headers)).status, JSON.stringify(Object.keys(headers))).toBe(401);

      // OAuth 2.0: discovery from the 401, the owner's consent, authorization code with PKCE.
      const challenge401 = await initialize({});
      const prmUrl = `https://${SELF_RELAY_HOST}/.well-known/oauth-protected-resource/d/${deviceId}/mcp`;
      expect(challenge401.headers["www-authenticate"]).toContain(`resource_metadata="${prmUrl}"`);
      const local = (url: string) => new URL(url).pathname;
      const prm = JSON.parse((await send(r.port, "GET", local(prmUrl), undefined, host)).text);
      const issuer = `https://${SELF_RELAY_HOST}/d/${deviceId}`;
      expect(prm).toMatchObject({
        resource: `https://${SELF_RELAY_HOST}${mcp}`,
        authorization_servers: [issuer],
        scopes_supported: ["mcp"],
      });
      const metadataPath = `/.well-known/oauth-authorization-server${local(issuer)}`;
      const meta = JSON.parse((await send(r.port, "GET", metadataPath, undefined, host)).text);
      expect(meta).toMatchObject({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        code_challenge_methods_supported: ["S256"],
      });
      const verifier = randomBytes(32).toString("base64url");
      const redirect = "https://client.example/callback";
      const clientId = `crot-${deviceId}`;
      const authorize = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "s1",
        scope: "mcp",
        resource: `https://${SELF_RELAY_HOST}${mcp}`,
      });
      const page = await send(r.port, "GET", `${local(meta.authorization_endpoint)}?${authorize}`, undefined, host);
      expect(page.status).toBe(200);
      const signed = /name="request" value="([^"]+)"/.exec(page.text)![1]!;
      const form = { ...host, "content-type": "application/x-www-form-urlencoded" };
      const decided = await send(
        r.port,
        "POST",
        local(meta.authorization_endpoint),
        new URLSearchParams({ request: signed, decision: "allow" }).toString(),
        { ...form, origin: `https://${SELF_RELAY_HOST}` },
      );
      expect(decided.status).toBe(303);
      const back = new URL(String(decided.headers.location));
      expect(`${back.origin}${back.pathname}`).toBe(redirect);
      expect(back.searchParams.get("state")).toBe("s1");
      expect(back.searchParams.get("iss")).toBe(issuer);
      const code = back.searchParams.get("code")!;
      const tokenRequest = (params: Record<string, string>, headers: Record<string, string> = {}) =>
        send(r.port, "POST", local(meta.token_endpoint), new URLSearchParams(params).toString(), {
          ...form,
          ...headers,
        });
      const clientAuth = { authorization: basicAuth(encodeURIComponent(clientId), encodeURIComponent(token)) };
      const exchange = { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier };
      const granted = await tokenRequest(exchange, clientAuth);
      expect(granted.status).toBe(200);
      expect(granted.headers["cache-control"]).toBe("no-store");
      expect(granted.headers["access-control-allow-origin"]).toBe("*");
      const first = JSON.parse(granted.text) as Record<string, string | number>;
      expect(first).toMatchObject({ token_type: "Bearer", scope: "mcp" });
      expect(first.access_token).toMatch(/^crot_at_/);
      expect(first.refresh_token).toMatch(/^crot_rt_/);
      expect(first.expires_in).toBeGreaterThan(3500);
      const viaAccess = await initialize({ authorization: `Bearer ${first.access_token}` });
      expect(viaAccess.status).toBe(200);
      expect(viaAccess.text).toContain('"serverInfo"');
      // Single-use code; the access token is not a client token for other forms.
      expect((await tokenRequest(exchange, clientAuth)).status).toBe(400);
      // Refresh (client_secret_post): rotation; the old refresh and access tokens stop working.
      const refreshed = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: String(first.refresh_token),
        client_id: clientId,
        client_secret: token,
      });
      expect(refreshed.status).toBe(200);
      const next = JSON.parse(refreshed.text) as Record<string, string>;
      expect((await initialize({ authorization: `Bearer ${next.access_token}` })).status).toBe(200);
      expect((await initialize({ authorization: `Bearer ${first.access_token}` })).status).toBe(401);
      expect(
        (await tokenRequest({ grant_type: "refresh_token", refresh_token: String(first.refresh_token) }, clientAuth))
          .status,
      ).toBe(400);
      // client_credentials (n8n, scripts) with the client token as the secret; a wrong secret is the device's 401.
      const direct = await tokenRequest({ grant_type: "client_credentials" }, clientAuth);
      expect(direct.status).toBe(200);
      const wrongSecret = await tokenRequest(
        { grant_type: "client_credentials" },
        { authorization: basicAuth(clientId, wrong) },
      );
      expect(wrongSecret.status).toBe(401);
      expect(JSON.parse(wrongSecret.text)).toEqual({ error: "invalid_client" });
      // Rotating the client token ends its OAuth grants.
      await ask("tokens.rotate", { id: issued.id });
      expect((await initialize({ authorization: `Bearer ${next.access_token}` })).status).toBe(401);
      const directAccess = (JSON.parse(direct.text) as Record<string, string>).access_token;
      expect((await initialize({ authorization: `Bearer ${directAccess}` })).status).toBe(401);
      expect(
        (await tokenRequest({ grant_type: "refresh_token", refresh_token: next.refresh_token! }, clientAuth)).status,
      ).toBe(401);
      // The relay logs neither the client token nor OAuth tokens.
      const logged = JSON.stringify(events);
      for (const secret of [token, code, first.access_token, first.refresh_token, next.access_token])
        expect(logged).not.toContain(String(secret));
      expect(events.some((e) => (e as { event?: string }).event === "oauth.token")).toBe(true);
    },
    60_000,
  );
});
