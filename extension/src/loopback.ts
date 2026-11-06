import type { BrowserInfoMessage } from "../../src/browser-bridge/protocol.js";
import type { ChromeEvent, ChromePort } from "./chrome-api.js";

/**
 * Loopback discovery and pairing with CROT Desktop (docs/BROWSER_EXTENSION.md,
 * "Automatic connection"; the Desktop side is src/browser-bridge/loopback.ts).
 *
 * Native messaging stays the primary, zero-click channel. When it is not
 * available (no host manifest for this browser), HostConnection asks this
 * module for a port:
 * 1. Discovery: GET http://127.0.0.1:43115-43119/extension/status. Only answers
 *    that identify CROT count; they carry no secrets and no tab data.
 * 2. Pairing, once per browser and Desktop: POST /extension/pair creates a
 *    request with a 6-digit code that both the popup and CROT Desktop show; the
 *    owner approves it on the Desktop Browser screen and the extension collects
 *    the pairing secret with the request key (POST /extension/pair/<id>).
 *    Requests start automatically only when exactly one CROT answers and the
 *    owner has not declined; otherwise the owner starts them from the popup.
 * 3. Connection: WebSocket /extension/command with a mutual HMAC-SHA256
 *    challenge over both nonces and the extension origin. CROT proves first,
 *    so a program squatting on the port learns nothing usable. The bridge
 *    protocol (hello, welcome, requests) then runs as one JSON text message per
 *    WebSocket message, with a keepalive ping that also keeps the service worker alive.
 *
 * The pairing secret is stored in chrome.storage.local (extension-private). A
 * pairing the owner forgets in CROT Desktop is refused (close code 4401); the
 * extension then drops it and pairs again.
 */

export const LOOPBACK_PORTS: readonly number[] = Object.freeze([43115, 43116, 43117, 43118, 43119]);
export const LOOPBACK_PROTOCOL_VERSION = 1;
export const LOOPBACK_STORAGE_KEY = "crot.loopback";
/** Keepalive: an active WebSocket keeps the service worker alive only while messages flow (< 30 s apart). */
export const LOOPBACK_PING_MS = 20_000;
/** How often a pending pairing request is polled. */
export const LOOPBACK_POLL_MS = 2_000;
export const LOOPBACK_PING = '{"type":"loopback_ping"}';
export const LOOPBACK_PONG = '{"type":"loopback_pong"}';
const PROBE_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** At most one automatic pairing request per minute (the Desktop also limits requests). */
const AUTO_REQUEST_INTERVAL_MS = 60_000;
const UNKNOWN_PAIRING = 4401;
const BAD_PROOF = 4403;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9]{6}$/;

/** The WebSocket members this module uses (the browser's WebSocket; a fake in tests). */
export interface LoopbackSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface LoopbackStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LoopbackOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly socket: (url: string) => LoopbackSocket;
  /** chrome.storage.local; absent: pairings last for the service worker's lifetime only. */
  readonly storage?: LoopbackStorage | undefined;
  /** chrome-extension://<id>: the Origin the browser sends, bound into every proof. */
  readonly origin: string;
  readonly browser: BrowserInfoMessage;
  readonly ports?: readonly number[];
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly pingMs?: number;
}

/** What the popup and the welcome page show about the loopback channel. */
export type LoopbackView =
  | { readonly state: "idle" | "searching" | "absent" | "rejected" }
  | { readonly state: "choose"; readonly desktops: readonly { readonly instance: string; readonly user: string }[] }
  | { readonly state: "pairing"; readonly code: string; readonly user: string; readonly expiresAt: number }
  | { readonly state: "paired"; readonly user: string }
  | { readonly state: "error"; readonly message: string };

interface Desktop {
  readonly port: number;
  readonly instance: string;
  readonly user: string;
}

interface StoredLink {
  readonly instance: string;
  readonly pairing: string;
  readonly secret: string;
  readonly user: string;
}

interface StoredRequest {
  readonly instance: string;
  readonly id: string;
  readonly key: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly user: string;
}

interface Stored {
  link?: StoredLink;
  pending?: StoredRequest;
  /** Desktop instance whose owner declined: no automatic requests to it until the owner asks again. */
  declined?: string;
  lastRequest?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const userName = (v: unknown): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) : "";

function parseStored(value: unknown): Stored {
  if (!isObject(value)) return {};
  const stored: Stored = {};
  const link = value.link;
  if (
    isObject(link) &&
    typeof link.instance === "string" &&
    HEX32.test(link.instance) &&
    typeof link.pairing === "string" &&
    HEX32.test(link.pairing) &&
    typeof link.secret === "string" &&
    HEX64.test(link.secret)
  )
    stored.link = { instance: link.instance, pairing: link.pairing, secret: link.secret, user: userName(link.user) };
  const p = value.pending;
  if (
    isObject(p) &&
    typeof p.instance === "string" &&
    HEX32.test(p.instance) &&
    typeof p.id === "string" &&
    HEX32.test(p.id) &&
    typeof p.key === "string" &&
    KEY.test(p.key) &&
    typeof p.code === "string" &&
    CODE.test(p.code) &&
    typeof p.expiresAt === "number"
  )
    stored.pending = {
      instance: p.instance,
      id: p.id,
      key: p.key,
      code: p.code,
      expiresAt: p.expiresAt,
      user: userName(p.user),
    };
  if (typeof value.declined === "string" && HEX32.test(value.declined)) stored.declined = value.declined;
  if (typeof value.lastRequest === "number") stored.lastRequest = value.lastRequest;
  return stored;
}

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** HMAC-SHA256 (hex) keyed with the pairing secret over NUL-joined parts, as the Desktop computes it. */
export async function loopbackProof(
  secretHex: string,
  role: "host" | "extension",
  clientNonce: string,
  serverNonce: string,
  origin: string,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromHex(secretHex), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const message = ["crot-loopback-v1", role, clientNonce, serverNonce, origin].join("\u0000");
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(message))));
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string" || data.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A ChromePort over an authenticated loopback WebSocket (one JSON message per WebSocket message). */
class SocketPort implements ChromePort {
  private readonly messageListeners = new Set<(message: unknown, port: ChromePort) => void>();
  private readonly disconnectListeners = new Set<(port: ChromePort) => void>();
  private closed = false;
  private readonly ping: ReturnType<typeof setInterval>;
  readonly onMessage: ChromeEvent<(message: unknown, port: ChromePort) => void> = {
    addListener: (listener) => void this.messageListeners.add(listener),
    removeListener: (listener) => void this.messageListeners.delete(listener),
  };
  readonly onDisconnect: ChromeEvent<(port: ChromePort) => void> = {
    addListener: (listener) => void this.disconnectListeners.add(listener),
    removeListener: (listener) => void this.disconnectListeners.delete(listener),
  };

  constructor(
    private readonly ws: LoopbackSocket,
    pingMs: number,
  ) {
    ws.onmessage = (event) => {
      if (this.closed) return;
      if (typeof event.data !== "string") return this.fail();
      if (event.data === LOOPBACK_PONG) return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return this.fail();
      }
      for (const listener of [...this.messageListeners]) listener(message, this);
    };
    ws.onclose = () => this.finish();
    ws.onerror = () => undefined;
    this.ping = setInterval(() => {
      try {
        ws.send(LOOPBACK_PING);
      } catch {
        this.fail();
      }
    }, pingMs);
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error("The loopback connection is closed.");
    this.ws.send(JSON.stringify(message));
  }

  /** Like Port.disconnect(): the local onDisconnect listeners are not called. */
  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    try {
      this.ws.close(1000, "");
    } catch {
      // Already closed.
    }
  }

  private fail(): void {
    try {
      this.ws.close(1002, "");
    } catch {
      // Already closed.
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    for (const listener of [...this.disconnectListeners]) listener(this);
  }
}

type Handshake = { readonly port: ChromePort } | { readonly failure: "unknown_pairing" | "untrusted" | "unavailable" };

export class LoopbackLink {
  private current: LoopbackView = { state: "idle" };
  private opening: Promise<ChromePort | undefined> | undefined;
  private memory: Stored = {};
  /** Owner request from the popup: pair now (optionally with one Desktop), even after a decline. */
  private wanted: { instance?: string } | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: LoopbackOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  get view(): LoopbackView {
    return this.current;
  }

  /** While a pairing request waits for the owner, it is polled quickly and native messaging is skipped. */
  get waiting(): boolean {
    return this.current.state === "pairing";
  }

  /** Delay before the next attempt (HostConnection), or undefined for its normal backoff. */
  get retryMs(): number | undefined {
    return this.current.state === "pairing" || this.wanted ? LOOPBACK_POLL_MS : undefined;
  }

  /** Owner action from the popup or welcome page: request a pairing now. */
  pair(instance?: string): void {
    this.wanted = instance && HEX32.test(instance) ? { instance } : {};
  }

  /** One attempt to obtain an authenticated port; never throws. Concurrent calls share the attempt. */
  open(): Promise<ChromePort | undefined> {
    this.opening ??= this.attempt()
      .catch((error: unknown) => {
        this.set({ state: "error", message: "Connection to CROT Desktop failed" });
        this.log("loopback: " + (error instanceof Error ? error.message : String(error)));
        return undefined;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  private set(view: LoopbackView): void {
    this.current = view;
  }

  private async load(): Promise<Stored> {
    if (!this.options.storage) return this.memory;
    try {
      return parseStored((await this.options.storage.get(LOOPBACK_STORAGE_KEY))[LOOPBACK_STORAGE_KEY]);
    } catch {
      return this.memory;
    }
  }

  private async save(stored: Stored): Promise<void> {
    this.memory = stored;
    try {
      await this.options.storage?.set({ [LOOPBACK_STORAGE_KEY]: stored });
    } catch {
      // Storage is unavailable: the pairing lasts for this service worker.
    }
  }

  private async attempt(): Promise<ChromePort | undefined> {
    if (this.current.state === "idle") this.set({ state: "searching" });
    const stored = await this.load();
    const desktops = await this.discover();
    if (!desktops.length) {
      this.set({ state: "absent" });
      return undefined;
    }
    const link = stored.link;
    const linked = link && desktops.find((d) => d.instance === link.instance);
    if (link && linked && !this.wanted) {
      const result = await this.handshake(linked.port, link);
      if ("port" in result) {
        this.set({ state: "paired", user: link.user || linked.user });
        return result.port;
      }
      if (result.failure !== "unknown_pairing") {
        this.set({
          state: "error",
          message:
            result.failure === "untrusted"
              ? "The program on the CROT port could not prove it is your CROT Desktop"
              : "CROT Desktop did not accept the connection",
        });
        return undefined;
      }
      // Forgotten in CROT Desktop (or its bridge token was rotated): pair again.
      this.log("loopback: CROT Desktop no longer knows this pairing; requesting a new one");
      delete stored.link;
      await this.save(stored);
    }
    return this.pairing(stored, desktops);
  }

  private async pairing(stored: Stored, desktops: readonly Desktop[]): Promise<ChromePort | undefined> {
    const wanted = this.wanted;
    const request = stored.pending;
    if (request && (!wanted || wanted.instance === undefined || wanted.instance === request.instance)) {
      const desktop = desktops.find((d) => d.instance === request.instance);
      if (desktop && request.expiresAt > this.now()) {
        const polled = await this.poll(desktop.port, request);
        if (polled === "pending") {
          this.wanted = undefined;
          this.set({ state: "pairing", code: request.code, user: request.user, expiresAt: request.expiresAt });
          return undefined;
        }
        if (polled === "rejected") {
          delete stored.pending;
          stored.declined = request.instance;
          await this.save(stored);
          this.wanted = undefined;
          this.set({ state: "rejected" });
          return undefined;
        }
        if (polled !== "unknown") {
          stored.link = polled;
          delete stored.pending;
          delete stored.declined;
          await this.save(stored);
          this.wanted = undefined;
          const result = await this.handshake(desktop.port, polled);
          if ("port" in result) {
            this.set({ state: "paired", user: polled.user });
            return result.port;
          }
          this.set({ state: "error", message: "CROT Desktop did not accept the connection" });
          return undefined;
        }
      }
      // Expired, or CROT restarted and forgot it.
      delete stored.pending;
      await this.save(stored);
    }
    const candidates = wanted?.instance ? desktops.filter((d) => d.instance === wanted.instance) : desktops;
    if (candidates.length !== 1) {
      this.wanted = undefined;
      this.set({ state: "choose", desktops: desktops.map(({ instance, user }) => ({ instance, user })) });
      return undefined;
    }
    const desktop = candidates[0]!;
    if (!wanted) {
      if (stored.declined === desktop.instance) {
        this.set({ state: "rejected" });
        return undefined;
      }
      if (stored.lastRequest !== undefined && Math.abs(this.now() - stored.lastRequest) < AUTO_REQUEST_INTERVAL_MS) {
        this.set({ state: "searching" });
        return undefined;
      }
    }
    this.wanted = undefined;
    stored.lastRequest = this.now();
    const created = await this.request(desktop);
    if (typeof created === "string") {
      await this.save(stored);
      this.set({ state: "error", message: created });
      return undefined;
    }
    stored.pending = created;
    delete stored.declined;
    await this.save(stored);
    this.log("loopback: pairing request " + created.code + " waits for approval in CROT Desktop");
    this.set({ state: "pairing", code: created.code, user: created.user, expiresAt: created.expiresAt });
    return undefined;
  }

  private async call(url: string, init: RequestInit, timeoutMs: number): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.options.fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(response: Response | undefined): Promise<Record<string, unknown> | undefined> {
    if (!response) return undefined;
    try {
      const value: unknown = await response.json();
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** CROT Desktops answering on the loopback ports (one entry per instance). */
  private async discover(): Promise<Desktop[]> {
    const ports = this.options.ports ?? LOOPBACK_PORTS;
    const found = await Promise.all(
      ports.map(async (port): Promise<Desktop | undefined> => {
        const response = await this.call(
          `http://127.0.0.1:${port}/extension/status`,
          { method: "GET" },
          PROBE_TIMEOUT_MS,
        );
        if (!response?.ok) return undefined;
        const body = await this.json(response);
        if (
          !body ||
          body.product !== "CROT" ||
          body.protocol !== LOOPBACK_PROTOCOL_VERSION ||
          typeof body.instance !== "string" ||
          !HEX32.test(body.instance)
        )
          return undefined;
        return { port, instance: body.instance, user: userName(body.user) };
      }),
    );
    const desktops: Desktop[] = [];
    for (const desktop of found)
      if (desktop && !desktops.some((d) => d.instance === desktop.instance)) desktops.push(desktop);
    return desktops;
  }

  /** A new pairing request, or the message the owner sees when CROT Desktop refuses it. */
  private async request(desktop: Desktop): Promise<StoredRequest | string> {
    const response = await this.call(
      `http://127.0.0.1:${desktop.port}/extension/pair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browser: this.options.browser }),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (response?.status === 429) return "Too many connection requests. Try again in a few minutes.";
    const body = response?.status === 201 ? await this.json(response) : undefined;
    if (
      !body ||
      typeof body.id !== "string" ||
      !HEX32.test(body.id) ||
      typeof body.key !== "string" ||
      !KEY.test(body.key) ||
      typeof body.code !== "string" ||
      !CODE.test(body.code) ||
      typeof body.expiresAt !== "number" ||
      body.instance !== desktop.instance
    )
      return "CROT Desktop did not accept the connection request";
    return {
      instance: desktop.instance,
      id: body.id,
      key: body.key,
      code: body.code,
      expiresAt: body.expiresAt,
      user: userName(body.user) || desktop.user,
    };
  }

  private async poll(port: number, request: StoredRequest): Promise<"pending" | "rejected" | "unknown" | StoredLink> {
    const response = await this.call(
      `http://127.0.0.1:${port}/extension/pair/${request.id}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: request.key }) },
      REQUEST_TIMEOUT_MS,
    );
    // Not reachable right now: keep waiting.
    if (!response) return "pending";
    const body = await this.json(response);
    if (!response.ok || !body) return "unknown";
    if (body.state === "pending") return "pending";
    if (body.state === "rejected") return "rejected";
    if (
      body.state === "approved" &&
      typeof body.pairing === "string" &&
      HEX32.test(body.pairing) &&
      typeof body.secret === "string" &&
      HEX64.test(body.secret) &&
      body.instance === request.instance
    )
      return { instance: request.instance, pairing: body.pairing, secret: body.secret, user: request.user };
    return "unknown";
  }

  /** The mutual challenge on /extension/command; resolves with the bridge port once CROT Desktop is proven. */
  private handshake(port: number, link: StoredLink): Promise<Handshake> {
    return new Promise((resolve) => {
      let ws: LoopbackSocket;
      try {
        ws = this.options.socket(`ws://127.0.0.1:${port}/extension/command`);
      } catch {
        resolve({ failure: "unavailable" });
        return;
      }
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
      let serverNonce: string | undefined;
      let done = false;
      const detach = () => {
        done = true;
        clearTimeout(timer);
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
      };
      const fail = (failure: "unknown_pairing" | "untrusted" | "unavailable") => {
        if (done) return;
        detach();
        try {
          ws.close(1000, "");
        } catch {
          // Already closed.
        }
        resolve({ failure });
      };
      const timer = setTimeout(() => fail("unavailable"), HANDSHAKE_TIMEOUT_MS);
      ws.onopen = () => {
        try {
          ws.send(
            JSON.stringify({ type: "loopback_auth", version: LOOPBACK_PROTOCOL_VERSION, pairing: link.pairing, nonce }),
          );
        } catch {
          fail("unavailable");
        }
      };
      ws.onmessage = (event) => {
        if (done) return;
        const message = parseJson(event.data);
        if (!message) return fail("untrusted");
        if (message.type === "loopback_error")
          return fail(message.code === "unknown_pairing" ? "unknown_pairing" : "unavailable");
        if (serverNonce === undefined) {
          const { nonce: server, proof } = message;
          if (
            message.type !== "loopback_challenge" ||
            typeof server !== "string" ||
            !HEX64.test(server) ||
            typeof proof !== "string" ||
            !HEX64.test(proof)
          )
            return fail("untrusted");
          serverNonce = server;
          void (async () => {
            const expected = await loopbackProof(link.secret, "host", nonce, server, this.options.origin);
            if (done) return;
            if (!sameHex(expected, proof)) return fail("untrusted");
            const answer = await loopbackProof(link.secret, "extension", nonce, server, this.options.origin);
            if (done) return;
            ws.send(JSON.stringify({ type: "loopback_proof", proof: answer }));
          })().catch(() => fail("unavailable"));
          return;
        }
        if (message.type !== "loopback_ready") return fail("untrusted");
        detach();
        resolve({ port: new SocketPort(ws, this.options.pingMs ?? LOOPBACK_PING_MS) });
      };
      ws.onclose = (event) =>
        fail(event.code === UNKNOWN_PAIRING || event.code === BAD_PROOF ? "unknown_pairing" : "unavailable");
      ws.onerror = () => undefined;
    });
  }
}
