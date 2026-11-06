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

describe("LoopbackLink discovery and pairing", () => {
  it("reports that no CROT Desktop answers", async () => {
    const { link: l } = link([]);
    await expect(open(l)).resolves.toBeUndefined();
    expect(l.view).toEqual({ state: "absent" });
  });

  it("requests one pairing from the only CROT Desktop and connects after the owner approves it", async () => {
    const desktop = new FakeDesktop(43116);
    const { link: l, storage } = link([desktop], { pingMs: 15 });
    await expect(open(l)).resolves.toBeUndefined();
    expect(desktop.requests.size).toBe(1);
    expect(desktop.browsers).toEqual([BROWSER]);
    expect(l.view).toMatchObject({ state: "pairing", code: "100000", user: "owner" });
    expect(l.waiting).toBe(true);
    // Still waiting for the owner: the same request is polled, no new one is created.
    await expect(open(l)).resolves.toBeUndefined();
    expect(desktop.requests.size).toBe(1);
    expect(l.view).toMatchObject({ state: "pairing", code: "100000" });

    desktop.decide("approved");
    const port = await open(l);
    expect(port).toBeDefined();
    expect(l.view).toEqual({ state: "paired", user: "owner" });
    expect(l.waiting).toBe(false);
    const stored = (storage as MemoryStorage).items[LOOPBACK_STORAGE_KEY] as { link?: { secret?: string } };
    expect(stored.link?.secret).toMatch(/^[0-9a-f]{64}$/);

    // The bridge protocol then runs as one JSON text message per WebSocket message.
    const received: unknown[] = [];
    port!.onMessage.addListener((message) => received.push(message));
    port!.postMessage({ type: "hello", protocol: 1 });
    expect(desktop.bridge).toEqual([{ type: "hello", protocol: 1 }]);
    desktop.sockets.at(-1)!.deliver(JSON.stringify({ type: "welcome", protocol: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(received).toEqual([{ type: "welcome", protocol: 1 }]);
    expect(desktop.pings).toBeGreaterThan(0);
  });

  it("reconnects with the stored pairing and no new request", async () => {
    const desktop = new FakeDesktop(43115);
    const first = link([desktop]);
    await open(first.link);
    desktop.decide("approved");
    expect(await open(first.link)).toBeDefined();
    const again = link([desktop], { storage: first.storage });
    expect(await open(again.link)).toBeDefined();
    expect(desktop.requests.size).toBe(0);
    expect(desktop.frames.filter((f) => f.includes("loopback_auth"))).toHaveLength(2);
  });

  it("never proves itself to a program that cannot prove the pairing secret first", async () => {
    const desktop = new FakeDesktop(43115);
    const { link: l, storage } = link([desktop]);
    await open(l);
    desktop.decide("approved");
    expect(await open(l)).toBeDefined();
    desktop.impostor = true;
    const frames = desktop.frames.length;
    const again = link([desktop], { storage });
    await expect(open(again.link)).resolves.toBeUndefined();
    expect(again.link.view).toEqual({
      state: "error",
      message: "The program on the CROT port could not prove it is your CROT Desktop",
    });
    expect(desktop.frames.slice(frames).map((f) => (JSON.parse(f) as { type: string }).type)).toEqual([
      "loopback_auth",
    ]);
  });

  it("pairs again after the owner forgot the pairing in CROT Desktop", async () => {
    const desktop = new FakeDesktop(43115);
    const { link: l, storage } = link([desktop]);
    await open(l);
    desktop.decide("approved");
    expect(await open(l)).toBeDefined();
    desktop.known.clear();
    const again = link([desktop], { storage, now: () => Date.now() + 120_000 });
    await expect(open(again.link)).resolves.toBeUndefined();
    expect(desktop.sockets.at(-1)!.closed).toBe(4401);
    expect(again.link.view).toMatchObject({ state: "pairing" });
    expect(((storage as MemoryStorage).items[LOOPBACK_STORAGE_KEY] as { link?: unknown }).link).toBeUndefined();
  });

  it("respects a decline until the owner asks again from the popup", async () => {
    const desktop = new FakeDesktop(43115);
    const { link: l } = link([desktop]);
    await open(l);
    desktop.decide("rejected");
    await open(l);
    expect(l.view).toEqual({ state: "rejected" });
    await open(l);
    expect(l.view).toEqual({ state: "rejected" });
    expect(desktop.browsers).toHaveLength(1);
    l.pair();
    expect(l.retryMs).toBeDefined();
    await open(l);
    expect(desktop.browsers).toHaveLength(2);
    expect(l.view).toMatchObject({ state: "pairing", code: "100001" });
  });

  it("creates at most one automatic request per minute", async () => {
    let now = Date.now();
    const desktop = new FakeDesktop(43115);
    const { link: l } = link([desktop], { now: () => now });
    await open(l);
    // CROT Desktop restarted and no longer knows the request.
    desktop.requests.clear();
    await open(l);
    expect(desktop.browsers).toHaveLength(1);
    expect(l.view).toEqual({ state: "searching" });
    now += 61_000;
    await open(l);
    expect(desktop.browsers).toHaveLength(2);
    expect(l.view).toMatchObject({ state: "pairing" });
  });

  it("lets the owner choose when several CROT Desktops answer", async () => {
    const a = new FakeDesktop(43115, "alice"),
      b = new FakeDesktop(43117, "bob");
    const { link: l } = link([a, b]);
    await open(l);
    expect(l.view).toEqual({
      state: "choose",
      desktops: [
        { instance: a.instance, user: "alice" },
        { instance: b.instance, user: "bob" },
      ],
    });
    expect(a.browsers.length + b.browsers.length).toBe(0);
    l.pair(b.instance);
    await open(l);
    expect(a.browsers).toHaveLength(0);
    expect(b.browsers).toHaveLength(1);
    expect(l.view).toMatchObject({ state: "pairing", user: "bob" });
  });

  it("shares one attempt between concurrent callers", async () => {
    const desktop = new FakeDesktop(43115);
    const { link: l } = link([desktop]);
    await Promise.all([open(l), open(l), open(l)]);
    expect(desktop.browsers).toHaveLength(1);
    await tick();
  });
});
