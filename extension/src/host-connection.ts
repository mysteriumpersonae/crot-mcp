import {
  BRIDGE_FEATURES,
  BRIDGE_PROTOCOL_VERSION,
  ChunkReassembler,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  parseHostMessage,
  type BrowserHello,
  type BrowserUiOpen,
  type BrowserNotice,
  type BrowserInfoMessage,
  type BrowserResponse,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";
import type { ChromeApi, ChromePort } from "./chrome-api.js";
import type { CommandHandlers } from "./commands.js";
import { cleanMessage, toWireError } from "./errors.js";
import type { LoopbackLink } from "./loopback.js";

/**
 * The extension's side of the browser bridge (protocol v1, see
 * src/browser-bridge/protocol.ts).
 *
 *   CROT Browser Extension <-native messaging-> crot-browser-relay <-IPC-> CROT Host
 *
 * Chrome's native messaging does the framing; messages are JSON objects.
 * 1. connectNative(NATIVE_HOST_NAME) starts the relay. The extension sends
 *    `hello` and waits for `welcome`.
 * 2. It then answers each `request` (possibly sent as `chunk`s) with exactly
 *    one `response`, plus bounded content-free lifecycle notices: the browser side cannot
 *    initiate operations, and authorization belongs to Core's PermissionEngine.
 * 3. Any protocol violation closes the port. After a disconnect (CROT not
 *    running, relay exit, another extension already connected) it reconnects
 *    with exponential backoff; background.ts also calls ensureConnected()
 *    from a periodic alarm, since timers do not survive the service worker
 *    being suspended. An open native port keeps the service worker alive.
 * 4. When native messaging fails before `welcome` (typically: no host manifest
 *    for this browser), the paired loopback channel to CROT Desktop is tried
 *    (loopback.ts). It carries the same protocol; native messaging is tried
 *    first again on every reconnect.
 */

export const NATIVE_HOST_NAME = "com.crot.host";
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** Time allowed between hello and welcome. */
export const WELCOME_TIMEOUT_MS = 10_000;
/** Requests the extension executes at the same time (the host sends at most 16). */
export const MAX_IN_FLIGHT = 32;
/** tabs_changed notices are coalesced: at most one per this interval (the host allows 120 notices a minute). */
export const TABS_CHANGED_INTERVAL_MS = 2_000;
/** ui_manage requests opening a browser tab: at most one per this interval. */
const MANAGE_INTERVAL_MS = 2_000;

export type HostConnectionState = "disconnected" | "connecting" | "connected";
export type HostTransport = "native" | "loopback";

export interface HostConnectionOptions {
  readonly runtime: ChromeApi["runtime"];
  readonly browser: BrowserInfoMessage;
  readonly handlers: CommandHandlers;
  /** Diagnostics: connection events only, never page data or request parameters. */
  readonly log?: (message: string) => void;
  /** Called after a connection ends (refs and debugger sessions of it become invalid, AD-16 point 5). */
  readonly onDisconnected?: () => void;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly welcomeTimeoutMs?: number;
  /** Fallback when native messaging is unavailable; absent: native messaging only. */
  readonly loopback?: LoopbackLink | undefined;
  /** The owner asked CROT Desktop to show the extension's management page (ui_manage). */
  readonly onManage?: () => void;
}

const utf8 = new TextEncoder();

export class HostConnection {
  private port: ChromePort | undefined;
  private connected = false;
  private readonly uiPending = new Map<
    string,
    { finish: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** Only the extension's own popup/welcome may call this through background.ts. */
  openControlCenter(): Promise<boolean> {
    if (!this.port || !this.connected || this.uiPending.size) return Promise.resolve(false);
    const port = this.port,
      id = "ui_" + crypto.randomUUID().replace(/-/g, "");
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(this.uiPending.get(id)?.timer);
        this.uiPending.delete(id);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 5000);
      this.uiPending.set(id, { finish, timer });
      if (!this.post(port, { type: "ui_open", id })) finish(false);
    });
  }
  /** Connection id the host assigned in `welcome` (AD-9); checked by gated commands (AD-11). */
  private connectionId: string | undefined;
  private reassembler = new ChunkReassembler();
  private readonly inFlight = new Set<string>();
  private failures = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly log: (message: string) => void;
  private portTransport: HostTransport = "native";
  /** Features the host announced in welcome (BRIDGE_FEATURES); a feature is used only when announced. */
  private hostFeatures: readonly string[] = [];
  /** A loopback attempt (discovery, pairing poll, handshake) is running. */
  private linking = false;
  private tabsTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTabsNotice = 0;
  private lastManage = 0;

  constructor(private readonly options: HostConnectionOptions) {
    this.log = options.log ?? (() => undefined);
  }

  get state(): HostConnectionState {
    if (!this.port) return this.linking ? "connecting" : "disconnected";
    return this.connected ? "connected" : "connecting";
  }

  /** The channel of the current connection; undefined while not connected. */
  get transport(): HostTransport | undefined {
    return this.port && this.connected ? this.portTransport : undefined;
  }

  /** Content-free hint that tabs changed, coalesced; sent only to a host that announced tabs-changed. */
  tabsChanged(): void {
    if (!this.connected || !this.hostFeatures.includes("tabs-changed") || this.tabsTimer) return;
    const wait = Math.max(250, TABS_CHANGED_INTERVAL_MS - (Date.now() - this.lastTabsNotice));
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = undefined;
      if (!this.connected) return;
      this.lastTabsNotice = Date.now();
      this.notify({ type: "browser_notice", event: "tabs_changed" });
    }, wait);
  }

  /** Fixed passive telemetry, never a request to execute a Core operation. */
  notify(notice: BrowserNotice): void {
    if (this.port && this.connected) this.post(this.port, notice);
  }

  /** Connect now unless a connection exists or is being set up. */
  ensureConnected(): void {
    if (this.port || this.stopped || this.linking) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }

  /** Disconnect and stop reconnecting for good. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.port) this.drop(this.port, "stopped");
  }

  private connect(): void {
    // A pairing request waiting for the owner is polled without retrying native messaging each time.
    if (this.options.loopback?.waiting) return this.connectLoopback();
    let port: ChromePort;
    try {
      port = this.options.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (error) {
      this.log("cannot start the CROT native host: " + describe(error));
      if (this.options.loopback) return this.connectLoopback();
      this.scheduleReconnect();
      return;
    }
    this.attach(port, "native");
  }

  /** Ask the loopback link for an authenticated port to CROT Desktop. */
  private connectLoopback(): void {
    const loopback = this.options.loopback;
    if (!loopback || this.stopped) return;
    this.linking = true;
    void loopback.open().then((port) => {
      this.linking = false;
      if (this.stopped || this.port) {
        port?.disconnect();
        return;
      }
      if (port) this.attach(port, "loopback");
      else this.scheduleReconnect();
    });
  }

  private attach(port: ChromePort, transport: HostTransport): void {
    this.port = port;
    this.portTransport = transport;
    this.hostFeatures = [];
    this.connected = false;
    this.connectionId = undefined;
    this.reassembler = new ChunkReassembler();
    this.inFlight.clear();
    for (const pending of this.uiPending.values()) pending.finish(false);
    port.onMessage.addListener((message) => this.receive(port, message));
    port.onDisconnect.addListener(() => {
      // Reading lastError marks it as handled.
      const reason = this.options.runtime.lastError?.message;
      if (this.port === port) this.closed(reason ?? "the CROT Host closed the connection");
    });
    const hello: BrowserHello = {
      type: "hello",
      protocol: BRIDGE_PROTOCOL_VERSION,
      browser: this.options.browser,
      features: [...BRIDGE_FEATURES],
    };
    if (!this.post(port, hello)) return;
    this.welcomeTimer = setTimeout(
      () => this.drop(port, "no welcome from the CROT Host"),
      this.options.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS,
    );
  }

  private receive(port: ChromePort, raw: unknown): void {
    if (this.port !== port) return;
    // UI acknowledgements may arrive while a large tool request is being reassembled.
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ui_result") {
      try {
        const result = parseHostMessage(raw);
        if (result.type !== "ui_result" || !this.connected) throw new Error("unexpected UI result");
        this.uiPending.get(result.id)?.finish(result.ok);
      } catch {
        this.drop(port, "protocol error: invalid UI result");
      }
      return;
    }
    let message;
    try {
      message = this.reassembler.accept(parseHostMessage(raw));
    } catch (error) {
      this.drop(port, "protocol error: " + describe(error));
      return;
    }
    if (message === undefined) return;
    if (message.type === "welcome") {
      if (this.connected) return this.drop(port, "protocol error: unexpected welcome");
      if (message.protocol !== BRIDGE_PROTOCOL_VERSION)
        return this.drop(port, "update required: unsupported protocol version " + message.protocol);
      clearTimeout(this.welcomeTimer);
      this.welcomeTimer = undefined;
      this.connected = true;
      this.connectionId = message.connectionId;
      this.hostFeatures = message.features ?? [];
      this.failures = 0;
      this.log("connected to the CROT Host" + (this.portTransport === "loopback" ? " (loopback)" : ""));
      return;
    }
    if (!this.connected) return this.drop(port, "protocol error: request before welcome");
    if (message.type === "ui_result") return this.drop(port, "protocol error: chunked UI result");
    if (message.type === "ui_manage") {
      const now = Date.now();
      if (now - this.lastManage >= MANAGE_INTERVAL_MS) {
        this.lastManage = now;
        try {
          this.options.onManage?.();
        } catch (error) {
          this.log("cannot open the extension page: " + describe(error));
        }
      }
      return;
    }
    if (this.inFlight.has(message.id)) return this.drop(port, "protocol error: duplicate request id");
    if (this.inFlight.size >= MAX_IN_FLIGHT) return this.drop(port, "protocol error: too many concurrent requests");
    this.inFlight.add(message.id);
    void this.execute(port, message);
  }

  private async execute(port: ChromePort, request: HostRequest): Promise<void> {
    let response: BrowserResponse;
    try {
      // The id is read when a command checks it, right before acting: a dropped port has none.
      const context = {
        connectionId: () => (this.port === port && this.connected ? this.connectionId : undefined),
        tabPolicy: request.tabPolicy,
      };
      const result = await this.options.handlers[request.command](request.params, context);
      response = { type: "response", id: request.id, ok: true, result };
    } catch (error) {
      response = { type: "response", id: request.id, ok: false, error: toWireError(error) };
    }
    // Answers for a connection that has gone away are discarded.
    if (this.port !== port || !this.inFlight.delete(request.id)) return;
    this.post(port, fitResponse(response));
  }

  private post(port: ChromePort, message: BrowserHello | BrowserResponse | BrowserNotice | BrowserUiOpen): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      this.drop(port, "cannot send to the CROT Host: " + describe(error));
      return false;
    }
  }

  /** Close the port ourselves (protocol violation, timeout). */
  private drop(port: ChromePort, reason: string): void {
    if (this.port !== port) return;
    try {
      port.disconnect();
    } catch {
      // Already disconnected.
    }
    this.closed(reason);
  }

  private closed(reason: string): void {
    const wasConnected = this.connected;
    const transport = this.portTransport;
    clearTimeout(this.welcomeTimer);
    this.welcomeTimer = undefined;
    clearTimeout(this.tabsTimer);
    this.tabsTimer = undefined;
    this.port = undefined;
    this.connected = false;
    this.connectionId = undefined;
    this.hostFeatures = [];
    this.inFlight.clear();
    this.log(
      (wasConnected ? "disconnected from the CROT Host: " : "could not connect to the CROT Host: ") +
        cleanMessage(reason),
    );
    if (wasConnected) this.failures = 0;
    try {
      this.options.onDisconnected?.();
    } catch (error) {
      this.log("cleanup after disconnect failed: " + describe(error));
    }
    // Native messaging is unavailable (no host for this browser, CROT not reachable through it): try loopback.
    if (!wasConnected && transport === "native" && this.options.loopback && !this.stopped)
      return this.connectLoopback();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    if (this.stopped) return;
    const min = this.options.reconnectMinMs ?? RECONNECT_MIN_MS;
    const max = this.options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    // A pairing request waiting for the owner is polled at a fixed short interval.
    const delay = this.options.loopback?.retryMs ?? Math.min(max, min * 2 ** Math.min(this.failures, 30));
    this.failures++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.port) this.connect();
    }, delay);
  }
}

const describe = (error: unknown): string => cleanMessage(error instanceof Error ? error.message : String(error));

/**
 * The response itself, or a LIMIT_EXCEEDED error when its JSON would exceed the
 * largest frame the host accepts (the relay would otherwise close the
 * connection), or OPERATION_FAILED when the result is not JSON-serializable.
 */
export function fitResponse(response: BrowserResponse): BrowserResponse {
  if (!response.ok) return response;
  let json: string | undefined;
  try {
    json = JSON.stringify(response);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    return {
      type: "response",
      id: response.id,
      ok: false,
      error: { code: "OPERATION_FAILED", message: "The result is not serializable." },
    };
  }
  // A UTF-16 code unit never takes more than 3 UTF-8 bytes; only encode when it may matter.
  if (json.length * 3 > MAX_BROWSER_TO_HOST_FRAME_BYTES && utf8.encode(json).length > MAX_BROWSER_TO_HOST_FRAME_BYTES) {
    return {
      type: "response",
      id: response.id,
      ok: false,
      error: { code: "LIMIT_EXCEEDED", message: "The result exceeds " + MAX_BROWSER_TO_HOST_FRAME_BYTES + " bytes." },
    };
  }
  return response;
}
