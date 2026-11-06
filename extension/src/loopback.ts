import type { BrowserInfoMessage } from "../../src/browser-bridge/protocol.js";
import type { ChromeEvent, ChromePort } from "./chrome-api.js";

/** Loopback uses credentials received from Native Messaging or an owner-only
 * unpacked-extension resource. Desktop proves the secret first using HMAC;
 * no credential is distributed via HTTP and no manual code is required.
 */

export const LOOPBACK_PORTS: readonly number[] = Object.freeze([43115, 43116, 43117, 43118, 43119]);
export const LOOPBACK_PROTOCOL_VERSION = 1;
export const LOOPBACK_STORAGE_KEY = "crot.loopback";
/** Keepalive: an active WebSocket keeps the service worker alive only while messages flow (< 30 s apart). */
export const LOOPBACK_PING_MS = 20_000;
export const LOOPBACK_PING = '{"type":"loopback_ping"}';
export const LOOPBACK_PONG = '{"type":"loopback_pong"}';
const PROBE_TIMEOUT_MS = 800;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const UNKNOWN_PAIRING = 4401;
const BAD_PROOF = 4403;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

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
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface LoopbackOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly socket: (url: string) => LoopbackSocket;
  /** chrome.storage.local; absent: pairings last for the service worker's lifetime only. */
  readonly storage?: LoopbackStorage | undefined;
  /** chrome-extension://<id>: the Origin the browser sends, bound into every proof. */
  readonly origin: string;
  readonly browser: BrowserInfoMessage;
  /** Private extension resource, not a web-accessible resource. */
  readonly bootstrapUrl?: string;
  readonly ports?: readonly number[];
  readonly log?: (message: string) => void;
  readonly pingMs?: number;
}

/** What the popup and the welcome page show about the loopback channel. */
export type LoopbackView =
  | { readonly state: "idle" | "searching" | "absent" }
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

interface Stored {
  link?: StoredLink;
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
  private readonly log: (message: string) => void;

  constructor(private readonly options: LoopbackOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Accept a credential only from the already authenticated native channel. */
  async bootstrap(value: { instance: string; pairing: string; secret: string }): Promise<void> {
    if (!HEX32.test(value.instance) || !HEX32.test(value.pairing) || !HEX64.test(value.secret)) return;
    await this.save({ link: { instance: value.instance, pairing: value.pairing, secret: value.secret, user: "" } });
  }

  get view(): LoopbackView {
    return this.current;
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
      await this.options.storage?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
      await this.options.storage?.set({ [LOOPBACK_STORAGE_KEY]: stored });
    } catch {
      // Storage is unavailable: the pairing lasts for this service worker.
    }
  }

  private async attempt(): Promise<ChromePort | undefined> {
    if (this.current.state === "idle") this.set({ state: "searching" });
    const stored = await this.load();
    if (this.options.bootstrapUrl) {
      const response = await this.call(this.options.bootstrapUrl, { method: "GET" }, PROBE_TIMEOUT_MS);
      const body = response?.ok ? await this.json(response) : undefined;
      if (
        body &&
        body.version === 1 &&
        typeof body.instance === "string" &&
        HEX32.test(body.instance) &&
        typeof body.pairing === "string" &&
        HEX32.test(body.pairing) &&
        typeof body.secret === "string" &&
        HEX64.test(body.secret)
      ) {
        stored.link = { instance: body.instance, pairing: body.pairing, secret: body.secret, user: "" };
        await this.save(stored);
      }
    }
    const desktops = await this.discover();
    if (!desktops.length) {
      this.set({ state: "absent" });
      return undefined;
    }
    const link = stored.link;
    const linked = link && desktops.find((d) => d.instance === link.instance);
    if (link && linked) {
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
      // A rotated or revoked credential must be replaced by a trusted bootstrap.
      this.log("loopback: CROT Desktop no longer knows this credential");
      delete stored.link;
      await this.save(stored);
    }
    this.set({ state: "absent" });
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
