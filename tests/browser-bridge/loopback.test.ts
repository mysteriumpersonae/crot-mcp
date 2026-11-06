import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_FEATURES, BRIDGE_PROTOCOL_VERSION } from "../../src/browser-bridge/protocol.js";
import {
  BROWSER_PAIRINGS_FILE_NAME,
  LOOPBACK_BAD_PROOF,
  LOOPBACK_UNKNOWN_PAIRING,
} from "../../src/browser-bridge/loopback.js";
import type { BrowserBridge } from "../../src/browser-bridge/server.js";
import { browserLinkHost, loopbackPorts, startBrowserBridge } from "../../src/cli/browser.js";
import { RELEASE_EXTENSION_ORIGINS } from "../../src/cli/release-extension-ids.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { connectWebSocket, type WebSocketConnection } from "../../src/tunnel/websocket.js";

const privateFiles = createPrivateFileProtection(process.platform === "win32");
const ORIGIN = RELEASE_EXTENSION_ORIGINS[0]!.replace(/\/$/, "");
const BROWSER = { name: "Chromium", version: "140.0.0.0", extensionVersion: "0.1.0" };

/** browser.link.status as the Browser screen reads it. */
interface LinkStatus {
  readonly state: string;
  readonly tabsRevision?: number;
  readonly loopback?: {
    readonly port?: number;
    readonly conflicts: readonly number[];
    readonly pending: readonly Record<string, unknown>[];
    readonly pairings: readonly Record<string, unknown>[];
  };
}
type Link = Omit<NonNullable<ReturnType<typeof browserLinkHost>>, "status"> & { status(): LinkStatus };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real bridge with its loopback endpoint on a free port, as the service starts it. */
async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-loopback-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const logs: string[] = [];
  const bridge = (await startBrowserBridge({
    enabled: true,
    stateDir,
    privateFiles,
    log: (message) => logs.push(message),
    loopbackPorts: [0],
  })) as BrowserBridge;
  cleanups.push(() => bridge.close());
  const host = browserLinkHost(bridge)!;
  const link: Link = { ...host, status: () => host.status() as unknown as LinkStatus };
  const port = bridge.loopbackEndpoint!.port!;
  expect(port).toBeGreaterThan(0);
  return { bridge, link, port, stateDir, logs };
}

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

/** Raw HTTP, so the test controls Host and Origin exactly. */
function http(port: number, method: string, pathname: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<Answer>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: {
          Host: "127.0.0.1:" + port,
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const fromExtension = { Origin: ORIGIN };

async function pairingRequest(port: number) {
  const created = await http(port, "POST", "/extension/pair", fromExtension, { browser: BROWSER });
  expect(created.status).toBe(201);
  return created.body as { id: string; key: string; code: string; expiresAt: number; instance: string; user: string };
}

/** A pairing approved by the owner and collected by the extension. */
async function paired(port: number, link: Link) {
  const request = await pairingRequest(port);
  expect(await link.approve(request.id)).toBe(true);
  const collected = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, { key: request.key });
  expect(collected.body).toMatchObject({ state: "approved", instance: request.instance });
  return collected.body as { pairing: string; secret: string; instance: string };
}

const proof = (secret: string, role: "host" | "extension", client: string, server: string, origin = ORIGIN) =>
  createHmac("sha256", Buffer.from(secret, "hex"))
    .update(["crot-loopback-v1", role, client, server, origin].join("\u0000"), "utf8")
    .digest("hex");

/** The extension side of /extension/command: messages in arrival order and the close code. */
async function socket(port: number, origin = ORIGIN) {
  const ws: WebSocketConnection = await connectWebSocket(`ws://127.0.0.1:${port}/extension/command`, {
    headers: { Origin: origin },
    maxMessageBytes: 1 << 20,
    timeoutMs: 5_000,
  });
  const messages: Record<string, unknown>[] = [];
  let waiters: (() => void)[] = [];
  let closed: number | undefined;
  ws.attach({
    onMessage: (data) => {
      messages.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      for (const w of waiters.splice(0)) w();
    },
    onClose: (code) => {
      closed = code;
      for (const w of waiters.splice(0)) w();
    },
  });
  cleanups.push(() => ws.close(1000, ""));
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!ok()) {
      if (Date.now() > end) throw new Error("timed out: " + JSON.stringify({ messages, closed }));
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    waiters = [];
  };
  return {
    send: (message: unknown) => ws.sendText(JSON.stringify(message)),
    messages,
    closed: () => closed,
    next: async (count: number) => {
      await until(() => messages.length >= count || closed !== undefined);
      return messages[count - 1];
    },
    close: async () => {
      await until(() => closed !== undefined);
      return closed;
    },
  };
}

/** Run the mutual challenge; resolves with the socket once CROT accepted the extension's proof. */
async function authenticate(port: number, pairing: string, secret: string) {
  const ws = await socket(port);
  const nonce = randomBytes(32).toString("hex");
  ws.send({ type: "loopback_auth", version: 1, pairing, nonce });
  const challenge = (await ws.next(1)) as { type: string; nonce: string; proof: string };
  expect(challenge.type).toBe("loopback_challenge");
  // CROT proves first: only the Desktop that derived the pairing secret can answer.
  expect(challenge.proof).toBe(proof(secret, "host", nonce, challenge.nonce));
  ws.send({ type: "loopback_proof", proof: proof(secret, "extension", nonce, challenge.nonce) });
  expect(await ws.next(2)).toEqual({ type: "loopback_ready" });
  return ws;
}

describe("browser loopback discovery (CROT_BROWSER_LOOPBACK_PORTS)", () => {
  it("parses the port list: default range, off, a free port, a list", () => {
    expect(loopbackPorts({})).toEqual([43115, 43116, 43117, 43118, 43119]);
    expect(loopbackPorts({ CROT_BROWSER_LOOPBACK_PORTS: "off" })).toBeUndefined();
    expect(loopbackPorts({ CROT_BROWSER_LOOPBACK_PORTS: "0" })).toEqual([0]);
    expect(loopbackPorts({ CROT_BROWSER_LOOPBACK_PORTS: "50000, 50001" })).toEqual([50000, 50001]);
    expect(loopbackPorts({ CROT_BROWSER_LOOPBACK_PORTS: "nope" })).toEqual([43115, 43116, 43117, 43118, 43119]);
  });

  it("identifies CROT without secrets or tab data, only to loopback requests with a loopback Host", async () => {
    const { port, link, bridge } = await start();
    const status = await http(port, "GET", "/extension/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      product: "CROT",
      protocol: 1,
      bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
      state: "waiting",
      instance: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(Object.keys(status.body).sort()).toEqual(
      ["bridgeProtocol", "instance", "product", "protocol", "service", "state", "user", "version"].sort(),
    );
    // No wildcard CORS: only the exact release extension origin is named.
    expect(status.headers["access-control-allow-origin"]).toBeUndefined();
    const extension = await http(port, "GET", "/extension/status", fromExtension);
    expect(extension.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const refusals: Record<string, string>[] = [
      { Origin: "https://example.com" },
      { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { Host: "evil.example:" + port },
      { Host: "127.0.0.1:1" },
    ];
    for (const headers of refusals) {
      const refused = await http(port, "GET", "/extension/status", headers);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: "forbidden" });
    }
    expect((await http(port, "POST", "/extension/pair", {}, { browser: BROWSER })).status).toBe(403);
    expect(link.status()).toMatchObject({
      state: "waiting",
      tabsRevision: bridge.tabsRevision,
      loopback: { port, conflicts: [], pending: [], pairings: [] },
    });
  });

  it("pairs once after the owner approves the code; the secret is delivered once and never stored", async () => {
    const { port, link, stateDir } = await start();
    const request = await pairingRequest(port);
    expect(request.code).toMatch(/^[0-9]{6}$/);
    expect(link.status().loopback?.pending).toEqual([
      { id: request.id, code: request.code, browser: BROWSER, expiresAt: request.expiresAt },
    ]);
    const wrongKey = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, {
      key: randomBytes(32).toString("base64url"),
    });
    expect(wrongKey.status).toBe(404);
    const pending = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, { key: request.key });
    expect(pending.body).toMatchObject({ state: "pending" });
    expect(await link.approve(request.id)).toBe(true);
    expect(await link.approve(request.id)).toBe(false);
    const approved = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, { key: request.key });
    expect(approved.body).toMatchObject({
      state: "approved",
      pairing: expect.stringMatching(/^[0-9a-f]{32}$/),
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const again = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, { key: request.key });
    expect(again.status).toBe(404);
    const status = link.status();
    expect(status.loopback?.pending).toEqual([]);
    expect(status.loopback?.pairings).toEqual([
      { id: approved.body.pairing, browser: BROWSER, created: expect.any(Number), connected: false },
    ]);
    const file = await readFile(path.join(stateDir, BROWSER_PAIRINGS_FILE_NAME), "utf8");
    expect(file).toContain(String(approved.body.pairing));
    expect(file).not.toContain(String(approved.body.secret));
  });

  it("tells the extension when the owner declines", async () => {
    const { port, link } = await start();
    const request = await pairingRequest(port);
    expect(link.reject(request.id)).toBe(true);
    const declined = await http(port, "POST", "/extension/pair/" + request.id, fromExtension, { key: request.key });
    expect(declined.body).toEqual({ state: "rejected" });
    expect(link.status().loopback?.pairings).toEqual([]);
    expect(await link.approve(request.id)).toBe(false);
  });

  it("connects the extension after the mutual proof and runs the bridge protocol as text messages", async () => {
    const { port, link, bridge } = await start();
    const { pairing, secret } = await paired(port, link);
    const ws = await authenticate(port, pairing, secret);
    ws.send({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, browser: BROWSER, features: [...BRIDGE_FEATURES] });
    const welcome = await ws.next(3);
    expect(welcome).toMatchObject({
      type: "welcome",
      protocol: BRIDGE_PROTOCOL_VERSION,
      features: [...BRIDGE_FEATURES],
    });
    const deadline = Date.now() + 5_000;
    while (link.status().state !== "connected" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(link.status()).toMatchObject({
      state: "connected",
      browser: BROWSER,
      transport: "loopback",
      manage: true,
      loopback: { pairings: [{ id: pairing, connected: true }] },
    });
    expect(bridge.manageExtension()).toBe(true);
    expect(await ws.next(4)).toMatchObject({ type: "ui_manage" });
    // Forgetting the pairing closes its connection and revokes the secret.
    expect(await link.forget(pairing)).toBe(true);
    await ws.close();
    const refused = await socket(port);
    refused.send({ type: "loopback_auth", version: 1, pairing, nonce: randomBytes(32).toString("hex") });
    expect(await refused.close()).toBe(LOOPBACK_UNKNOWN_PAIRING);
    expect(refused.messages).toEqual([{ type: "loopback_error", code: "unknown_pairing" }]);
  });

  it("refuses a wrong proof, a web origin and another path", async () => {
    const { port, link } = await start();
    const { pairing, secret } = await paired(port, link);
    const ws = await socket(port);
    const nonce = randomBytes(32).toString("hex");
    ws.send({ type: "loopback_auth", version: 1, pairing, nonce });
    await ws.next(1);
    ws.send({ type: "loopback_proof", proof: proof(secret, "extension", nonce, "0".repeat(64)) });
    expect(await ws.close()).toBe(LOOPBACK_BAD_PROOF);
    expect(ws.messages.map((m) => m.type)).toEqual(["loopback_challenge"]);
    await expect(socket(port, "https://example.com")).rejects.toThrow();
    await expect(
      connectWebSocket(`ws://127.0.0.1:${port}/extension/other`, {
        headers: { Origin: ORIGIN },
        maxMessageBytes: 1 << 20,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
    expect(link.status().state).toBe("waiting");
  });
});
