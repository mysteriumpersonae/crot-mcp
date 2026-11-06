/**
 * Local browser discovery and mutually authenticated WebSocket bridge.
 * Credentials are delivered over authenticated Native Messaging or an
 * owner-only unpacked-extension resource; HTTP never distributes a secret.
 * Both proofs bind the extension origin and fresh nonces. Same-OS-user
 * processes may read owner-only files and are outside this isolation boundary.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { userInfo } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { acceptWebSocket, type WebSocketConnection } from "../tunnel/websocket.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  MAX_BROWSER_INFO_LENGTH,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  encodeFrame,
} from "./protocol.js";
import type { BridgeSocket } from "./server.js";

export const LOOPBACK_PORTS: readonly number[] = Object.freeze([43115, 43116, 43117, 43118, 43119]);
export const LOOPBACK_PROTOCOL_VERSION = 1;
export const BROWSER_PAIRINGS_FILE_NAME = "browser-pairings.json";
export const LOOPBACK_PING = '{"type":"loopback_ping"}';
export const LOOPBACK_PONG = '{"type":"loopback_pong"}';
/** WebSocket close codes of the pairing handshake. */
export const LOOPBACK_UNKNOWN_PAIRING = 4401;
export const LOOPBACK_BAD_PROOF = 4403;

const MAX_PAIRINGS = 16;
const MAX_BODY_BYTES = 4096;
const MAX_HANDSHAKE_MESSAGE_BYTES = 512;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_HANDSHAKES = 4;
const MAX_AUTH_FAILURES_PER_MINUTE = 30;
const PROBE_TIMEOUT_MS = 800;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;

export function browserPairingsFile(stateDir: string): string {
  return path.join(stateDir, BROWSER_PAIRINGS_FILE_NAME);
}

export interface LoopbackBrowser {
  readonly name: string;
  readonly version: string;
  readonly extensionVersion: string;
}

export interface LoopbackPairingView {
  readonly id: string;
  readonly browser: LoopbackBrowser;
  readonly extensionId: string;
  readonly created: number;
  readonly connected: boolean;
}

export interface LoopbackStatus {
  /** Port this CROT listens on; absent when every port was taken. */
  readonly port?: number;
  /** Ports of the range held by something that is not CROT (owner warning). */
  readonly conflicts: readonly number[];
  readonly instance: string;
  readonly pending: readonly never[];
  readonly pairings: readonly LoopbackPairingView[];
}

interface StoredPairing {
  readonly id: string;
  readonly extensionId: string;
  readonly browser: LoopbackBrowser;
  readonly created: number;
}

interface PairingFile {
  readonly version: 1;
  readonly instance: string;
  pairings: StoredPairing[];
}

/** The bridge as the loopback endpoint needs it (BrowserBridge). */
export interface LoopbackBridge {
  acceptLoopback(socket: BridgeSocket): void;
  state(): { readonly kind: string };
  loopbackKey(): Buffer;
}

export interface LoopbackOptions {
  readonly bridge: LoopbackBridge;
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  readonly version: string;
  /** Exact origins of release extensions, e.g. chrome-extension://<id> (no trailing slash). */
  readonly extensionOrigins: readonly string[];
  readonly log: (message: string) => void;
  /** Ports tried in order (default LOOPBACK_PORTS); [0] picks a free port (tests). */
  readonly ports?: readonly number[];
  readonly now?: () => number;
  /** Desktop account shown to the owner in the extension (default: the OS user name). */
  readonly user?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= MAX_BROWSER_INFO_LENGTH && PRINTABLE.test(v);

function parseBrowser(value: unknown): LoopbackBrowser | undefined {
  if (!isObject(value)) return undefined;
  const { name, version, extensionVersion } = value;
  return text(name) && text(version) && text(extensionVersion) ? { name, version, extensionVersion } : undefined;
}

function parseFile(raw: string): PairingFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.version !== 1 || typeof value.instance !== "string" || !HEX32.test(value.instance))
    return undefined;
  if (!Array.isArray(value.pairings)) return undefined;
  const pairings: StoredPairing[] = [];
  for (const p of value.pairings.slice(0, MAX_PAIRINGS)) {
    if (!isObject(p) || typeof p.id !== "string" || !HEX32.test(p.id)) continue;
    const browser = parseBrowser(p.browser);
    if (!browser || typeof p.extensionId !== "string" || !/^[a-p]{32}$/.test(p.extensionId)) continue;
    pairings.push({ id: p.id, extensionId: p.extensionId, browser, created: Number(p.created) || 0 });
  }
  return { version: 1, instance: value.instance, pairings };
}

/** HMAC-SHA256 hex digest over NUL-joined parts. */
function mac(key: Buffer, ...parts: string[]): string {
  return createHmac("sha256", key).update(parts.join("\u0000"), "utf8").digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"),
    y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The pairing secret both sides use for the challenge (hex of 32 bytes). */
export function loopbackPairingSecret(key: Buffer, instance: string, pairing: string): string {
  return mac(key, "pairing", instance, pairing);
}

/** Challenge proofs: the host proves first, so a squatting listener cannot drive the extension. */
export function loopbackProof(
  secretHex: string,
  role: "host" | "extension",
  clientNonce: string,
  serverNonce: string,
  origin: string,
): string {
  return mac(Buffer.from(secretHex, "hex"), "crot-loopback-v1", role, clientNonce, serverNonce, origin);
}

/**
 * One authenticated loopback WebSocket presented to the bridge as a byte
 * stream: each frame the bridge writes becomes one text message, each text
 * message a frame for its reader. Keepalive pings are answered here.
 */
class LoopbackChannel extends EventEmitter implements BridgeSocket {
  private pending: Buffer = Buffer.alloc(0);
  private gone = false;

  constructor(
    private readonly ws: WebSocketConnection,
    readonly pairing: string,
  ) {
    super();
    ws.attach({
      onMessage: (data, binary) => {
        if (this.gone) return;
        if (binary) {
          this.destroy();
          return;
        }
        if (data.length === LOOPBACK_PING.length && data.toString("utf8") === LOOPBACK_PING) {
          ws.sendText(LOOPBACK_PONG);
          return;
        }
        this.emit("data", Buffer.from(encodeFrame(data)));
      },
      onTooLarge: () => this.destroy(),
      onClose: () => this.finish(),
    });
  }

  get destroyed(): boolean {
    return this.gone || !this.ws.isOpen;
  }

  write(chunk: Uint8Array): boolean {
    if (this.destroyed) return false;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= FRAME_HEADER_BYTES) {
      const size = this.pending.readUInt32LE(0);
      if (this.pending.length < FRAME_HEADER_BYTES + size) break;
      const body = this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size);
      this.pending = this.pending.subarray(FRAME_HEADER_BYTES + size);
      this.ws.sendText(body.toString("utf8"));
    }
    return true;
  }

  end(): void {
    this.ws.close(1000, "");
  }

  destroy(): void {
    this.ws.terminate();
    this.finish();
  }

  private finish(): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("close");
  }
}

export class LoopbackServer {
  private server: Server | undefined;
  private boundPort: number | undefined;
  private readonly conflictPorts: number[] = [];
  private failures: number[] = [];
  private readonly live = new Map<string, Set<LoopbackChannel>>();
  private handshakes = 0;
  private closed = false;
  private readonly now: () => number;
  private readonly key: Buffer;
  private readonly user: string;

  private constructor(
    private readonly options: LoopbackOptions,
    private readonly file: PairingFile,
  ) {
    this.now = options.now ?? Date.now;
    this.key = options.bridge.loopbackKey();
    let user = options.user;
    if (user === undefined) {
      try {
        user = userInfo().username;
      } catch {
        user = "";
      }
    }
    this.user = user.slice(0, 64);
  }

  /** Load the pairing metadata and listen on the first free port of the range. Never throws for a busy range. */
  static async start(options: LoopbackOptions): Promise<LoopbackServer> {
    const file = browserPairingsFile(options.stateDir);
    const loaded = parseFile(await readFile(file, "utf8").catch(() => ""));
    const server = new LoopbackServer(
      options,
      loaded ?? { version: 1, instance: randomBytes(16).toString("hex"), pairings: [] },
    );
    if (!loaded) await server.persist();
    await server.listen();
    return server;
  }

  get port(): number | undefined {
    return this.boundPort;
  }

  get instance(): string {
    return this.file.instance;
  }

  /** Credentials scoped to this Desktop instance and release extension origin. */
  bootstrap(origin: string): { instance: string; pairing: string; secret: string } | undefined {
    if (!this.options.extensionOrigins.includes(origin)) return undefined;
    const instance = this.file.instance;
    const pairing = mac(this.key, "automatic-pairing", instance, origin).slice(0, 32);
    return { instance, pairing, secret: loopbackPairingSecret(this.key, instance, pairing) };
  }

  /** Native host registration has a single pinned extension identity. */
  nativeBootstrap(): { instance: string; pairing: string; secret: string } | undefined {
    return this.options.extensionOrigins.length === 1 ? this.bootstrap(this.options.extensionOrigins[0]!) : undefined;
  }

  status(): LoopbackStatus {
    this.expire();
    return {
      ...(this.boundPort !== undefined ? { port: this.boundPort } : {}),
      conflicts: [...this.conflictPorts],
      instance: this.file.instance,
      pending: [],
      pairings: this.file.pairings.map((p) => ({
        id: p.id,
        browser: p.browser,
        extensionId: p.extensionId,
        created: p.created,
        connected: (this.live.get(p.id)?.size ?? 0) > 0,
      })),
    };
  }

  // Legacy owner commands cannot create or approve new pairing requests.
  async approve(_id: string): Promise<boolean> {
    return false;
  }
  reject(_id: string): boolean {
    return false;
  }

  /** Revoke a pairing: its secret stops working and its open connection closes. */
  async forget(id: string): Promise<boolean> {
    const previous = this.file.pairings;
    if (!previous.some((p) => p.id === id)) return false;
    this.file.pairings = previous.filter((p) => p.id !== id);
    try {
      await this.persist();
    } catch (error) {
      this.file.pairings = previous;
      throw error;
    }
    this.disconnect(id);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.live.keys()]) this.disconnect(id);
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private disconnect(pairing: string): void {
    for (const channel of this.live.get(pairing) ?? []) channel.destroy();
    this.live.delete(pairing);
  }

  private async persist(): Promise<void> {
    const file = browserPairingsFile(this.options.stateDir);
    await this.options.privateFiles.ensureDirectory(this.options.stateDir);
    const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
    const mode = this.options.privateFiles.fileMode !== undefined ? { mode: this.options.privateFiles.fileMode } : {};
    await writeFile(temp, JSON.stringify(this.file, null, 2) + "\n", { encoding: "utf8", flag: "wx", ...mode });
    await this.options.privateFiles.protectFile?.(temp);
    await rename(temp, file);
  }

  private expire(): void {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
  }

  private async listen(): Promise<void> {
    const ports = this.options.ports ?? LOOPBACK_PORTS;
    for (const port of ports) {
      if (this.closed) return;
      const server = createServer({ maxHeaderSize: 8192 }, (req, res) => this.handle(req, res));
      server.headersTimeout = 5_000;
      server.requestTimeout = 10_000;
      server.keepAliveTimeout = 2_000;
      server.maxHeadersCount = 40;
      server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
      server.on("clientError", (_error, socket) => socket.destroy());
      const bound = await new Promise<number | NodeJS.ErrnoException>((resolve) => {
        server.once("error", (error: NodeJS.ErrnoException) => resolve(error));
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
      if (typeof bound === "number") {
        if (this.closed) {
          server.close();
          return;
        }
        server.on("error", (error) => this.options.log("browser loopback: server error: " + error.message));
        this.server = server;
        this.boundPort = bound;
        this.options.log("browser loopback: discovery for the CROT Browser Extension on 127.0.0.1:" + bound);
        return;
      }
      if (bound.code !== "EADDRINUSE" && bound.code !== "EACCES") {
        this.options.log("browser loopback: cannot listen on 127.0.0.1:" + port + ": " + bound.message);
        continue;
      }
      const crot = await probeCrot(port);
      if (!crot) {
        this.conflictPorts.push(port);
        this.options.log(
          "browser loopback: 127.0.0.1:" + port + " is held by a program that is not CROT; trying the next port",
        );
      }
    }
    this.options.log("browser loopback: no free port in the range; the extension uses native messaging only");
  }

  private loopbackRequest(req: IncomingMessage): boolean {
    const peer = req.socket.remoteAddress;
    if (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1") return false;
    const host = req.headers.host;
    const port = this.boundPort;
    return port !== undefined && (host === "127.0.0.1:" + port || host === "localhost:" + port);
  }

  private extensionOrigin(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    return typeof origin === "string" && this.options.extensionOrigins.includes(origin) ? origin : undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const allowed = this.extensionOrigin(req);
    // Not loopback, a rebinding Host, or a web page: no CORS headers, no data.
    if (!this.loopbackRequest(req) || (origin !== undefined && !allowed)) return send(res, 403, { error: "forbidden" });
    const cors: Record<string, string> = allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {};
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      if (!allowed) return send(res, 403, { error: "forbidden" });
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    if (url.pathname === "/extension/status" && req.method === "GET") return send(res, 200, this.publicStatus(), cors);
    if (!allowed) return send(res, 403, { error: "extension origin required" });
    send(res, 404, { error: "not found" }, cors);
  }

  private publicStatus(): Record<string, unknown> {
    return {
      product: "CROT",
      service: "crot-desktop",
      version: this.options.version,
      protocol: LOOPBACK_PROTOCOL_VERSION,
      bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
      instance: this.file.instance,
      user: this.user,
      state: this.options.bridge.state().kind,
    };
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    this.expire();
    const origin = this.extensionOrigin(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      this.closed ||
      !this.loopbackRequest(req) ||
      !origin ||
      url.pathname !== "/extension/command" ||
      this.handshakes >= MAX_HANDSHAKES ||
      this.failures.length >= MAX_AUTH_FAILURES_PER_MINUTE
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: MAX_BROWSER_TO_HOST_FRAME_BYTES });
    if (!ws) return;
    this.handshakes++;
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      this.handshakes--;
      clearTimeout(timer);
      return true;
    };
    const fail = (code: number, reason: string) => {
      if (!finish()) return;
      this.failures.push(this.now());
      ws.close(code, reason);
    };
    const timer = setTimeout(() => fail(4408, "handshake timeout"), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
    let challenge:
      { pairing: string; legacy?: StoredPairing; secret: string; clientNonce: string; serverNonce: string } | undefined;
    ws.attach({
      onMessage: (data, binary) => {
        if (finished) return;
        if (binary || data.length > MAX_HANDSHAKE_MESSAGE_BYTES) return fail(1002, "invalid handshake");
        let message: unknown;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return fail(1002, "invalid handshake");
        }
        if (!isObject(message)) return fail(1002, "invalid handshake");
        if (!challenge) {
          const { type, version, pairing, nonce } = message;
          if (
            type !== "loopback_auth" ||
            version !== LOOPBACK_PROTOCOL_VERSION ||
            typeof pairing !== "string" ||
            !HEX32.test(pairing) ||
            typeof nonce !== "string" ||
            !HEX64.test(nonce)
          )
            return fail(1002, "invalid handshake");
          const auto = this.bootstrap(origin);
          const stored = this.file.pairings.find(
            (p) => p.id === pairing && "chrome-extension://" + p.extensionId === origin,
          );
          if (auto?.pairing !== pairing && !stored) {
            ws.sendText(JSON.stringify({ type: "loopback_error", code: "unknown_pairing" }));
            return fail(LOOPBACK_UNKNOWN_PAIRING, "unknown pairing");
          }
          const secret = loopbackPairingSecret(this.key, this.file.instance, pairing);
          const serverNonce = randomBytes(32).toString("hex");
          challenge = { pairing, ...(stored ? { legacy: stored } : {}), secret, clientNonce: nonce, serverNonce };
          ws.sendText(
            JSON.stringify({
              type: "loopback_challenge",
              nonce: serverNonce,
              proof: loopbackProof(secret, "host", nonce, serverNonce, origin),
            }),
          );
          return;
        }
        const proof = message.proof;
        if (
          message.type !== "loopback_proof" ||
          typeof proof !== "string" ||
          !HEX64.test(proof) ||
          !sameHex(
            proof,
            loopbackProof(challenge.secret, "extension", challenge.clientNonce, challenge.serverNonce, origin),
          )
        )
          return fail(LOOPBACK_BAD_PROOF, "invalid proof");
        if (challenge.legacy && !this.file.pairings.includes(challenge.legacy))
          return fail(LOOPBACK_UNKNOWN_PAIRING, "unknown pairing");
        finish();
        ws.sendText(JSON.stringify({ type: "loopback_ready" }));
        const channel = new LoopbackChannel(ws, challenge.pairing);
        const set = this.live.get(channel.pairing) ?? new Set<LoopbackChannel>();
        set.add(channel);
        this.live.set(channel.pairing, set);
        channel.on("close", () => {
          set.delete(channel);
          if (!set.size && this.live.get(channel.pairing) === set) this.live.delete(channel.pairing);
        });
        this.options.bridge.acceptLoopback(channel);
      },
      onTooLarge: () => fail(1009, "handshake too large"),
      onClose: () => {
        finish();
      },
    });
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(json)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

/** Whether CROT answers on a port of the range (another instance or account), within PROBE_TIMEOUT_MS. */
function probeCrot(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/extension/status",
        method: "GET",
        headers: { Host: "127.0.0.1:" + port },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY_BYTES) chunks.push(c);
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { product?: unknown };
            resolve(body.product === "CROT");
          } catch {
            resolve(false);
          }
        });
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
