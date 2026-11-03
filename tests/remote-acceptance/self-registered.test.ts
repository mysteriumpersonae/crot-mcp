/**
 * Owner-approved self-registration: MCP client → relay /d/<id>/mcp with a Bearer token from
 * tokens.issue → WebSocket tunnel → CrotService (no pairing, no cloud OAuth).
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
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
async function desktopService(relayPort: number, selfRelayHost: string, selfRetry?: { baseMs: number }) {
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
        http: { enabled: false },
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
