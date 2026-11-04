/**
 * The device tunnel inside the service (WP-30, ARCHITECTURE.md §27 AD-22).
 *
 * While remote mode is on and the device is paired in the active identity
 * environment, the service keeps one tunnel to the Cloud Relay. Requests of
 * the tunnel enter a second, loopback-only `CrotHttpServer` with the relay
 * entry point (AD-15 point 1): OAuth access tokens bound to this device and
 * account (AD-21), device-side admission (remote mode, revocation; AD-19),
 * then Core with its PermissionEngine, ExecutionGuard, approvals and audit,
 * exactly as for any other request. The tunnel adds no authorization.
 *
 * Remote mode off, unpairing or a binding that no longer matches the
 * environment close the tunnel with GOAWAY `remote_disabled` / `unpaired`
 * (AD-22 point 9); the control center ends the remote requests in flight
 * through the registered relay entry (AD-19 point 8).
 *
 * A device that is not paired can still be reached through its self-registered
 * identity (owner-approved): the tunnel then forwards to a loopback server that
 * accepts the client tokens issued on this device (tokens.issue) — the service's
 * HTTP server when HTTP is enabled, otherwise one of its own, so the relay URL
 * works with the desktop app's default configuration (HTTP disabled).
 */
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { CrotHttpServer, type OAuthTokenHandler, type RemoteAdmission } from "../adapters/http/server.js";
import type { Principal } from "../core/auth/principal.js";
import type { HttpConfig } from "../core/config/schema.js";
import type { CrotCore } from "../core/crot-core.js";
import {
  DeviceTunnel,
  DeviceTunnelManager,
  type DeviceTunnelManagerOptions,
  type DeviceTunnelTiming,
  type TunnelManagerState,
  type TunnelManagerStatus,
} from "../tunnel/device-tunnel.js";
import { ControlCenter, type ControlConnection, type RemoteEntry } from "./control-center.js";
import type { TunnelCredential, TunnelCredentialResult } from "./device-binding.js";
import { selfRegistrationChallenge } from "../identity/device-credential.js";
import type { ControlOverview, ControlRequest } from "./protocol.js";

/** Upper bound of one self-registration request at the relay. */
const SELF_REGISTER_TIMEOUT_MS = 10_000;
/** First and longest wait after a failed self-registration (the relay rate-limits registrations). */
const SELF_RETRY_BASE_MS = 5_000;
const SELF_RETRY_CAP_MS = 5 * 60_000;
/** How long `reconnect` waits for the attempt it started. */
const RECONNECT_WAIT_MS = 8_000;

/** Test seams of the tunnel (ServiceOptions.tunnel). */
export interface RemoteTunnelSeams {
  /** The tunnel URL for a relay host (default `wss://<relayHost>/.crot/tunnel`). */
  readonly url?: (relayHost: string) => string;
  readonly timing?: Partial<DeviceTunnelTiming>;
  readonly backoff?: DeviceTunnelManagerOptions["backoff"];
  /** How often the service re-checks remote mode and the binding (default 2 s). */
  readonly watchIntervalMs?: number;
  /** The relay's HTTP origin for self-registration (default `https://<relayHost>`). */
  readonly registerOrigin?: (relayHost: string) => string;
  /** The relay host of the self-registered tunnel (default `crot.network`, see resolveSelfRelayHost). */
  readonly selfRelayHost?: string;
  /** Waits after a failed self-registration: the first one and the longest (default 5 s and 5 min). */
  readonly selfRetry?: { readonly baseMs?: number; readonly capMs?: number };
}

export interface RemoteTunnelOptions extends RemoteTunnelSeams {
  readonly core: CrotCore;
  readonly http: HttpConfig;
  readonly verifier: AccessTokenVerifier;
  readonly admission: RemoteAdmission;
  readonly resourceMetadataUrl: () => string | undefined;
  readonly addRemoteEntry: (entry: RemoteEntry) => () => void;
  readonly credential: () => TunnelCredentialResult;
  /**
   * Self-registered credential (owner-approved): used while the device is not paired.
   * Its tunnel targets a loopback HTTP server, which validates client Bearer tokens.
   */
  readonly selfCredential?: () => TunnelCredential | undefined;
  /** The service's loopback HTTP server, when HTTP is enabled: the self tunnel then targets it. */
  readonly selfTargetPort?: () => number | undefined;
  /**
   * The token check of the self tunnel's own loopback server while HTTP is disabled: the same
   * client tokens (tokens.issue) and admission as the HTTP server, never the relay's OAuth.
   */
  readonly selfEntry?: {
    readonly verifier: AccessTokenVerifier;
    readonly principalAdmission: (principal: Principal) => boolean;
    /** The loopback OAuth token endpoint (client credentials and refresh grants). */
    readonly oauthToken?: OAuthTokenHandler;
  };
  readonly remoteMode: () => boolean;
  readonly software: string;
  readonly log: (message: string) => void;
  readonly onStatus?: () => void;
}

/** AD-22 point 6: maxStreams = maxConcurrentRequests + maxSessions, at most 1024. */
const MAX_STREAMS_CAP = 1024;
/** The HTTP adapter's default for http.maxConcurrentRequests (DEFAULT_MAX_CONCURRENT_REQUESTS). */
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

export const TUNNEL_CLOSED_NOTE =
  "The relay tunnel is closed: remote mode is off or this device is not paired in the active identity environment.";

/** Methods after which remote reachability may have changed. */
const REMOTE_METHODS: ReadonlySet<string> = new Set(["remote.setMode", "pairing.start"]);

/**
 * The control center with the tunnel's state in the overview and a hook
 * after remote mode or pairing changed (the tunnel follows at once).
 */
export class TunnelControlCenter extends ControlCenter {
  tunnelView: (() => string | undefined) | undefined;
  tunnelState: (() => TunnelManagerState | undefined) | undefined;
  onRemoteChange: (() => void | Promise<void>) | undefined;
  /** `remote.reconnect`: register again, reconnect now and report the tunnel's state afterwards. */
  onReconnect: (() => Promise<TunnelManagerStatus>) | undefined;

  protected override async afterLocalUnpair(): Promise<void> {
    await this.onRemoteChange?.();
  }

  protected override async reconnectRemote(): ReturnType<ControlCenter["reconnectRemote"]> {
    if (!this.onReconnect) return super.reconnectRemote();
    const status = await this.onReconnect();
    return {
      ok: true,
      tunnel: { state: status.state, ...(status.reason ? { reason: status.reason } : {}) },
      overview: this.overview(),
    };
  }

  override handle(connection: ControlConnection, request: ControlRequest): ReturnType<ControlCenter["handle"]> {
    const result = super.handle(connection, request);
    if (result && REMOTE_METHODS.has(request.method))
      void result.then(
        () => this.onRemoteChange?.(),
        () => undefined,
      );
    return result;
  }

  override overview(): ControlOverview {
    const overview = super.overview();
    const tunnel = this.tunnelView?.();
    const tunnelState = this.tunnelState?.();
    return tunnel === undefined
      ? overview
      : { ...overview, remote: { ...overview.remote, tunnel, ...(tunnelState ? { tunnelState } : {}) } };
  }
}

export class RemoteTunnel {
  private server: CrotHttpServer | undefined;
  /** The self tunnel's own loopback server while HTTP is disabled. */
  private selfServer: CrotHttpServer | undefined;
  private unregister: (() => void) | undefined;
  private manager: DeviceTunnelManager | undefined;
  private watcher: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private mode: "paired" | "self" | undefined;
  private selfRegistered: string | undefined;
  /** Why the last self-registration failed, until one succeeds (overview and retry). */
  private selfProblem: string | undefined;
  private selfFailures = 0;
  private selfRetryAt = 0;
  /** Incremented on every status change of the current manager (reconnect waits for the next one). */
  private statusSeq = 0;

  constructor(private readonly options: RemoteTunnelOptions) {}

  /** Re-check periodically (pairing completes, environment changes) besides the control hook. */
  watch(): void {
    if (this.watcher || this.closed) return;
    this.watcher = setInterval(() => void this.sync(), this.options.watchIntervalMs ?? 2_000);
    this.watcher.unref();
  }

  /**
   * Open or close the tunnel to match remote mode and the binding. Serialized. `force` (the owner
   * turned remote mode on or asked for a check) registers the self identity again at once instead
   * of waiting for the retry delay of an earlier failure.
   */
  sync(options: { readonly force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    this.queue = this.queue
      .then(() => this.syncOnce(force))
      .catch((error: unknown) => this.options.log(`tunnel: ${error instanceof Error ? error.message : String(error)}`));
    return this.queue;
  }

  /** Reconnect now instead of waiting for the backoff (system resume). */
  nudge(): void {
    this.manager?.nudge();
  }

  /**
   * "Check tunnel" in the tray: a forced sync (self-registration included), then an immediate
   * connection attempt; waits up to `waitMs` for that attempt and returns the state afterwards.
   */
  async reconnect(waitMs = RECONNECT_WAIT_MS): Promise<TunnelManagerStatus> {
    const until = Date.now() + waitMs;
    // A hanging registration must not hold the tray's control request past the deadline; the sync
    // itself goes on in the background.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.sync({ force: true }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    const manager = this.manager;
    if (!manager || this.closed || manager.status.state === "ready") return this.status;
    const seq = this.statusSeq;
    manager.nudge();
    while (Date.now() < until && !this.closed && this.manager === manager) {
      const s = manager.status;
      if (s.state === "ready" || (this.statusSeq !== seq && s.state !== "connecting")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.status;
  }

  /** End the sessions of a revoked client token on the self tunnel's own loopback server. */
  async endPrincipal(principal: Principal): Promise<void> {
    await this.selfServer?.endPrincipal(principal);
  }

  /** The relay entry point's loopback URL (tests and diagnostics). */
  get entryUrl(): string | undefined {
    return this.server?.url;
  }

  get status(): TunnelManagerStatus {
    if (this.manager) return this.manager.status;
    if (this.selfProblem !== undefined)
      return { state: "waiting", reason: this.selfProblem, nextAttemptAt: this.selfRetryAt };
    return { state: "stopped" };
  }

  /** The tunnel's state for the tray overview (AD-22 point 9). */
  view(): string {
    const manager = this.manager;
    if (!manager) {
      return this.selfProblem !== undefined
        ? `The relay did not register this device (${this.selfProblem}); retrying.`
        : TUNNEL_CLOSED_NOTE;
    }
    const s = manager.status;
    switch (s.state) {
      case "ready":
        return "Connected to the relay; remote requests can reach this device.";
      case "connecting":
        return "Connecting to the relay.";
      case "waiting":
        return `Not connected to the relay (${s.reason ?? "disconnected"}); retrying.`;
      case "blocked":
        return `The relay refused this device (${s.reason ?? "refused"}); retrying hourly or after a change.`;
      default:
        return TUNNEL_CLOSED_NOTE;
    }
  }

  private async syncOnce(force: boolean): Promise<void> {
    if (this.closed) return;
    const credential = this.options.credential();
    const remote = this.options.remoteMode();
    const self = !credential.ok && remote ? this.options.selfCredential?.() : undefined;
    const mode = remote && credential.ok ? "paired" : self ? "self" : undefined;
    if (this.manager && this.mode !== mode) {
      const manager = this.manager;
      const code = remote && this.mode === "paired" && !credential.ok ? "unpaired" : "remote_disabled";
      this.manager = undefined;
      this.mode = undefined;
      await manager.stop(code);
      this.options.log(`tunnel: closed (${code})`);
      this.options.onStatus?.();
    }
    if (mode !== "self") {
      if (this.selfProblem !== undefined) {
        this.selfProblem = undefined;
        this.options.onStatus?.();
      }
      await this.closeSelfServer();
    }
    if (mode === "self" && self) {
      await this.syncSelf(self, force);
      return;
    }
    const wanted = mode === "paired";
    if (wanted && !this.manager) {
      if (!this.server) {
        const http = this.options.http;
        this.server = await CrotHttpServer.start(this.options.core, {
          config: { ...http, host: "127.0.0.1", port: 0 },
          verifier: this.options.verifier,
          entryPoint: "relay",
          remoteAdmission: this.options.admission,
          resourceMetadataUrl: this.options.resourceMetadataUrl,
          log: this.options.log,
        });
        this.unregister = this.options.addRemoteEntry(this.server);
      }
      this.mode = "paired";
      this.manager = this.newManager(() => {
        const c = this.options.credential();
        return c.ok ? c.credential : undefined;
      }, this.server.port);
      this.manager.start();
      this.options.log("tunnel: remote mode on and paired; connecting to the relay");
    } else if (!wanted && this.manager && this.mode === "paired") {
      const manager = this.manager;
      this.manager = undefined;
      const code = credential.ok ? "remote_disabled" : "unpaired";
      await manager.stop(code);
      this.mode = undefined;
      this.options.log(`tunnel: closed (${code})`);
      this.options.onStatus?.();
    }
  }

  /**
   * Self mode: register the key at the relay (again after a refusal), then keep one tunnel to the
   * loopback server. Failures wait 5 s, 10 s, … up to 5 min unless the owner forces a retry.
   */
  private async syncSelf(self: TunnelCredential, force: boolean): Promise<void> {
    const manager = this.manager;
    if (manager) {
      const s = manager.status;
      // "unauthorized": the relay does not know this key (any more): register again, then retry now.
      if (s.state !== "blocked" || s.reason !== "unauthorized") return;
      if (!force && Date.now() < this.selfRetryAt) return;
      this.selfRegistered = undefined;
      if (!(await this.selfRegister(self))) return;
      // A refusal right after registering must not loop: the next re-registration waits.
      this.selfRetryAt = Date.now() + this.selfRetryDelay(++this.selfFailures);
      manager.nudge();
      return;
    }
    if (!force && Date.now() < this.selfRetryAt) return;
    if (force) this.selfRegistered = undefined;
    if (!(await this.selfRegister(self))) return;
    const port = this.options.selfTargetPort?.() ?? (await this.openSelfServer());
    if (port === undefined || this.closed) return;
    this.mode = "self";
    this.manager = this.newManager(() => this.options.selfCredential?.(), port);
    this.manager.start();
    this.options.log(`tunnel: remote mode on, self-registered device; connecting to ${self.relayHost}`);
  }

  /** The self tunnel's own loopback server (HTTP disabled): client tokens, never the local admin token. */
  private async openSelfServer(): Promise<number | undefined> {
    if (this.selfServer) return this.selfServer.port;
    const entry = this.options.selfEntry;
    if (!entry) return undefined;
    this.selfServer = await CrotHttpServer.start(this.options.core, {
      config: { ...this.options.http, host: "127.0.0.1", port: 0 },
      verifier: entry.verifier,
      principalAdmission: entry.principalAdmission,
      ...(entry.oauthToken ? { oauthToken: entry.oauthToken } : {}),
      log: this.options.log,
    });
    this.options.log("tunnel: HTTP is disabled; the self-registered tunnel uses its own loopback entry");
    return this.selfServer.port;
  }

  private async closeSelfServer(): Promise<void> {
    const server = this.selfServer;
    this.selfServer = undefined;
    await server?.close();
  }

  private selfRetryDelay(failures: number): number {
    const base = this.options.selfRetry?.baseMs ?? SELF_RETRY_BASE_MS;
    const cap = this.options.selfRetry?.capMs ?? SELF_RETRY_CAP_MS;
    return Math.min(cap, base * 2 ** Math.min(Math.max(0, failures - 1), 20));
  }

  private newManager(credential: () => TunnelCredential | undefined, port: number): DeviceTunnelManager {
    const http = this.options.http;
    const maxStreams = Math.min(
      MAX_STREAMS_CAP,
      (http.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS) + http.maxSessions,
    );
    const url = this.options.url ?? DeviceTunnel.urlFor;
    return new DeviceTunnelManager({
      credential,
      url: (c) => url(c.relayHost),
      target: { host: "127.0.0.1", port },
      maxStreams,
      software: this.options.software,
      ...(this.options.timing ? { timing: this.options.timing } : {}),
      ...(this.options.backoff ? { backoff: this.options.backoff } : {}),
      log: this.options.log,
      onStatus: (status) => {
        this.statusSeq++;
        if (status.state === "ready") {
          this.selfFailures = 0;
          this.selfRetryAt = 0;
        }
        this.options.onStatus?.();
      },
    });
  }

  /** Register the self credential's key at the relay (idempotent there); false after a failure. */
  private async selfRegister(c: TunnelCredential): Promise<boolean> {
    const key = `${c.relayHost}/${c.deviceId}`;
    if (this.selfRegistered === key) return true;
    const origin = this.options.registerOrigin?.(c.relayHost) ?? `https://${c.relayHost}`;
    let problem: string;
    try {
      const res = await fetch(`${origin}/d/${c.deviceId}/self-register`, {
        method: "POST",
        // Remote mode is on by default, so this runs at every start: never hold the service start up for long.
        signal: AbortSignal.timeout(SELF_REGISTER_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: c.publicKey,
          proof: c.prove(selfRegistrationChallenge(c.deviceId)).toString("base64url"),
        }),
      });
      await res.text().catch(() => "");
      if (res.status === 200 || res.status === 201) {
        this.selfRegistered = key;
        if (this.selfProblem !== undefined) {
          this.selfProblem = undefined;
          this.options.onStatus?.();
        }
        this.options.log(`tunnel: self-registered at ${c.relayHost} (${res.status})`);
        return true;
      }
      problem = `refused_${res.status}`;
      this.options.log(`tunnel: self-registration at ${c.relayHost} refused (${res.status})`);
    } catch (error) {
      problem = "unreachable";
      this.options.log(
        `tunnel: self-registration at ${c.relayHost} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    this.selfFailures++;
    this.selfRetryAt = Date.now() + this.selfRetryDelay(this.selfFailures);
    this.selfProblem = problem;
    this.options.onStatus?.();
    return false;
  }

  /** Shutdown: GOAWAY shutting_down, then the relay entry point closes. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.watcher) clearInterval(this.watcher);
    await this.queue;
    const manager = this.manager;
    this.manager = undefined;
    await manager?.stop("shutting_down");
    this.unregister?.();
    await this.server?.close();
    await this.closeSelfServer();
  }
}
