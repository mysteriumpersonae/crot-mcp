import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ChromePort } from "../src/chrome-api.js";
import {
  LOOPBACK_PING,
  LOOPBACK_PONG,
  LOOPBACK_STORAGE_KEY,
  LoopbackLink,
  type LoopbackOptions,
  type LoopbackSocket,
  type LoopbackStorage,
} from "../src/loopback.js";

const ORIGIN = "chrome-extension://bllcepanlhojbddfbbpegmnokpaakool";
const BROWSER = { name: "Google Chrome", version: "140.0.7339.80", extensionVersion: "0.1.0" };

/** The Desktop side of the challenge (src/browser-bridge/loopback.ts), written independently with node:crypto. */
const proof = (secret: string, role: "host" | "extension", client: string, server: string) =>
  createHmac("sha256", Buffer.from(secret, "hex"))
    .update(["crot-loopback-v1", role, client, server, ORIGIN].join("\u0000"), "utf8")
    .digest("hex");
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Request {
  readonly key: string;
  readonly code: string;
  state: "pending" | "approved" | "rejected";
}

/** One CROT Desktop on one loopback port: status, pairing requests and the WebSocket challenge. */
class FakeDesktop {
  readonly instance = hex(16);
  readonly requests = new Map<string, Request>();
  /** Pairings the Desktop still knows (forget: delete). */
  readonly known = new Map<string, string>();
  /** Every text message the extension sent over the WebSocket. */
  readonly frames: string[] = [];
  /** Bridge messages after the challenge succeeded. */
  readonly bridge: unknown[] = [];
  sockets: FakeSocket[] = [];
  pings = 0;
  /** A program squatting on the port that does not know the pairing secret. */
  impostor = false;
  browsers: unknown[] = [];

  constructor(
    readonly port: number,
    readonly user = "owner",
  ) {}

  respond(url: URL, init: RequestInit): Response {
    if (url.pathname === "/extension/status")
      return json(200, { product: "CROT", protocol: 1, version: "0.1.0", instance: this.instance, user: this.user });
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.pathname === "/extension/pair" && init.method === "POST") {
      const id = hex(16),
        request = {
          key: randomBytes(32).toString("base64url"),
          code: String(100000 + this.requests.size),
          state: "pending" as const,
        };
      this.requests.set(id, { ...request });
      this.browsers.push(body.browser);
      const expiresAt = Date.now() + 300_000;
      return json(201, {
        id,
        key: request.key,
        code: request.code,
        expiresAt,
        instance: this.instance,
        user: this.user,
      });
    }
    const match = /^\/extension\/pair\/([0-9a-f]{32})$/.exec(url.pathname);
    const request = match && this.requests.get(match[1]!);
    if (!match || !request || body.key !== request.key) return json(404, { error: "unknown request" });
    if (request.state !== "approved") return json(200, { state: request.state });
    const pairing = hex(16),
      secret = hex(32);
    this.known.set(pairing, secret);
    this.requests.delete(match[1]!);
    return json(200, { state: "approved", pairing, secret, instance: this.instance });
  }

  decide(state: "approved" | "rejected"): void {
    for (const request of this.requests.values()) request.state = state;
  }
}

class FakeSocket implements LoopbackSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed: number | undefined;
  private client: string | undefined;
  private server: string | undefined;
  private secret: string | undefined;
  private ready = false;

  constructor(private readonly desktop: FakeDesktop) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string): void {
    if (this.closed !== undefined) throw new Error("WebSocket is already in CLOSING or CLOSED state.");
    this.desktop.frames.push(data);
    if (data === LOOPBACK_PING) {
      this.desktop.pings++;
      return this.deliver(LOOPBACK_PONG);
    }
    const message = JSON.parse(data) as Record<string, string>;
    if (this.ready) return void this.desktop.bridge.push(message);
    if (message.type === "loopback_auth") {
      this.secret = this.desktop.known.get(message.pairing!);
      if (!this.secret && !this.desktop.impostor) return this.end(4401);
      this.client = message.nonce;
      this.server = hex(32);
      const answer = this.desktop.impostor ? hex(32) : proof(this.secret!, "host", this.client!, this.server);
      return this.deliver(JSON.stringify({ type: "loopback_challenge", nonce: this.server, proof: answer }));
    }
    if (
      message.type === "loopback_proof" &&
      message.proof === proof(this.secret!, "extension", this.client!, this.server!)
    ) {
      this.ready = true;
      return this.deliver(JSON.stringify({ type: "loopback_ready" }));
    }
    this.end(4403);
  }

  close(code = 1000): void {
    if (this.closed === undefined) this.end(code);
  }

  /** CROT Desktop sends a text message. */
  deliver(data: string): void {
    setTimeout(() => {
      if (this.closed === undefined) this.onmessage?.({ data });
    }, 0);
  }

  end(code: number): void {
    this.closed = code;
    setTimeout(() => this.onclose?.({ code }), 0);
  }
}

class MemoryStorage implements LoopbackStorage {
  items: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.items ? { [key]: structuredClone(this.items[key]) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.items, structuredClone(items));
  }
}

const ports: ChromePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.disconnect();
});

/** The extension's loopback link against the given Desktops; every other port answers like a foreign web server. */
function link(desktops: FakeDesktop[], options: Partial<LoopbackOptions> & { storage?: LoopbackStorage } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.hostname !== "127.0.0.1") throw new TypeError("Failed to fetch");
    const desktop = desktops.find((d) => d.port === Number(u.port));
    if (!desktop)
      return u.port === "43119" ? json(200, { product: "nginx" }) : Promise.reject(new TypeError("Failed to fetch"));
    return desktop.respond(u, init);
  };
  const socket = (url: string) => {
    const u = new URL(url);
    const desktop = desktops.find((d) => d.port === Number(u.port));
    if (!desktop || u.pathname !== "/extension/command") throw new Error("connection refused");
    const ws = new FakeSocket(desktop);
    desktop.sockets.push(ws);
    return ws;
  };
  const created = new LoopbackLink({
    fetch,
    socket,
    storage,
    origin: ORIGIN,
    browser: BROWSER,
    ports: [43115, 43116, 43117, 43118, 43119],
    ...options,
  });
  return { link: created, storage };
}

async function open(l: LoopbackLink): Promise<ChromePort | undefined> {
  const port = await l.open();
  if (port) ports.push(port);
  return port;
}

describe("LoopbackLink automatic credentials", () => {
  it("reports no Desktop and never requests a pairing code", async () => {
    const { link: l } = link([]);
    await expect(open(l)).resolves.toBeUndefined();
    expect(l.view).toEqual({ state: "absent" });
    const desktop = new FakeDesktop(43115);
    const noCredential = link([desktop]);
    await expect(open(noCredential.link)).resolves.toBeUndefined();
    expect(desktop.requests.size).toBe(0);
    expect(desktop.frames).toHaveLength(0);
  });

  it("persists native bootstrap and reconnects with mutual proof", async () => {
    const desktop = new FakeDesktop(43115);
    const pairing = hex(16),
      secret = hex(32);
    desktop.known.set(pairing, secret);
    const first = link([desktop], { pingMs: 15 });
    await first.link.bootstrap({ instance: desktop.instance, pairing, secret });
    const port = await open(first.link);
    expect(port).toBeDefined();
    expect(first.link.view).toEqual({ state: "paired", user: "owner" });
    const stored = (first.storage as MemoryStorage).items[LOOPBACK_STORAGE_KEY] as { link?: { secret?: string } };
    expect(stored.link?.secret === secret).toBe(true);
    const received: unknown[] = [];
    port!.onMessage.addListener((message) => received.push(message));
    port!.postMessage({ type: "hello", protocol: 1 });
    expect(desktop.bridge).toEqual([{ type: "hello", protocol: 1 }]);
    desktop.sockets.at(-1)!.deliver(JSON.stringify({ type: "welcome", protocol: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(received).toEqual([{ type: "welcome", protocol: 1 }]);
    expect(desktop.pings).toBeGreaterThan(0);
    const again = link([desktop], { storage: first.storage });
    expect(await open(again.link)).toBeDefined();
    expect(desktop.requests.size).toBe(0);
  });

  it("never proves itself to an impostor", async () => {
    const desktop = new FakeDesktop(43115);
    const pairing = hex(16),
      secret = hex(32);
    desktop.known.set(pairing, secret);
    const { link: l } = link([desktop]);
    await l.bootstrap({ instance: desktop.instance, pairing, secret });
    desktop.impostor = true;
    await expect(open(l)).resolves.toBeUndefined();
    expect(l.view).toMatchObject({ state: "error" });
    expect(desktop.frames.map((f) => (JSON.parse(f) as { type: string }).type)).toEqual(["loopback_auth"]);
  });

  it("drops unknown credentials without requesting codes", async () => {
    const desktop = new FakeDesktop(43115);
    const { link: l, storage } = link([desktop]);
    await l.bootstrap({ instance: desktop.instance, pairing: hex(16), secret: hex(32) });
    await expect(open(l)).resolves.toBeUndefined();
    expect(desktop.sockets.at(-1)!.closed).toBe(4401);
    expect(desktop.requests.size).toBe(0);
    expect(((storage as MemoryStorage).items[LOOPBACK_STORAGE_KEY] as { link?: unknown }).link).toBeUndefined();
  });

  it("loads an isolated extension resource and shares concurrent attempts", async () => {
    const desktop = new FakeDesktop(43115);
    const pairing = hex(16),
      secret = hex(32);
    desktop.known.set(pairing, secret);
    let fetches = 0;
    const { link: l } = link([desktop], {
      bootstrapUrl: "chrome-extension://example/.bridge-secret.json",
      fetch: async (url) => {
        if (url.startsWith("chrome-extension:")) {
          fetches++;
          return json(200, { version: 1, instance: desktop.instance, pairing, secret });
        }
        const u = new URL(url);
        return Number(u.port) === desktop.port ? desktop.respond(u, {}) : Promise.reject(new TypeError("unavailable"));
      },
    });
    const results = await Promise.all([open(l), open(l), open(l)]);
    expect(results.every(Boolean)).toBe(true);
    expect(fetches).toBe(1);
    expect(desktop.requests.size).toBe(0);
    await tick();
  });
});
