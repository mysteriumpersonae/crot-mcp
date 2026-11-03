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
 */
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { CrotHttpServer, type RemoteAdmission } from "../adapters/http/server.js";
import type { HttpConfig } from "../core/config/schema.js";
import type { CrotCore } from "../core/crot-core.js";
import {
  DeviceTunnel,
  DeviceTunnelManager,
  type DeviceTunnelManagerOptions,
  type DeviceTunnelTiming,
  type TunnelManagerStatus,
} from "../tunnel/device-tunnel.js";
import { ControlCenter, type ControlConnection, type RemoteEntry } from "./control-center.js";
import type { TunnelCredential, TunnelCredentialResult } from "./device-binding.js";
import { selfRegistrationChallenge } from "../identity/device-credential.js";
import type { ControlOverview, ControlRequest } from "./protocol.js";

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
   * Its tunnel targets the loopback HTTP server, which validates client Bearer tokens.
   */
  readonly selfCredential?: () => TunnelCredential | undefined;
  readonly selfTargetPort?: () => number | undefined;
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
  onRemoteChange: (() => void | Promise<void>) | undefined;

  protected override async afterLocalUnpair(): Promise<void> {
    await this.onRemoteChange?.();
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
    return tunnel === undefined ? overview : { ...overview, remote: { ...overview.remote, tunnel } };
  }
}

export class RemoteTunnel {
  private server: CrotHttpServer | undefined;
  private unregister: (() => void) | undefined;
  private manager: DeviceTunnelManager | undefined;
  private watcher: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private mode: "paired" | "self" | undefined;
  private selfRegistered: string | undefined;

  constructor(private readonly options: RemoteTunnelOptions) {}

  /** Re-check periodically (pairing completes, environment changes) besides the control hook. */
  watch(): void {
    if (this.watcher || this.closed) return;
    this.watcher = setInterval(() => void this.sync(), this.options.watchIntervalMs ?? 2_000);
    this.watcher.unref();
  }

  /** Open or close the tunnel to match remote mode and the binding. Serialized. */
  sync(): Promise<void> {
    this.queue = this.queue
      .then(() => this.syncOnce())
      .catch((error: unknown) => this.options.log(`tunnel: ${error instanceof Error ? error.message : String(error)}`));
    return this.queue;
  }

  /** Reconnect now instead of waiting for the backoff (system resume). */
  nudge(): void {
    this.manager?.nudge();
  }

  /** The relay entry point's loopback URL (tests and diagnostics). */
  get entryUrl(): string | undefined {
    return this.server?.url;
  }

  get status(): TunnelManagerStatus {
    return this.manager?.status ?? { state: "stopped" };
  }

  /** The tunnel's state for the tray overview (AD-22 point 9). */
  view(): string {
    const manager = this.manager;
    if (!manager) return TUNNEL_CLOSED_NOTE;
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

  private async syncOnce(): Promise<void> {
    if (this.closed) return;
    const credential = this.options.credential();
    const remote = this.options.remoteMode();
    const selfPort = this.options.selfTargetPort?.();
    const self = !credential.ok && remote && selfPort !== undefined ? this.options.selfCredential?.() : undefined;
    const mode = remote && credential.ok ? "paired" : self ? "self" : undefined;
    if (this.manager && this.mode !== mode) {
      const manager = this.manager;
      this.manager = undefined;
      const code = mode === undefined && !credential.ok ? "unpaired" : "remote_disabled";
      await manager.stop(code);
      this.options.log(`tunnel: closed (${code})`);
      this.options.onStatus?.();
    }
    if (mode === "self" && self && selfPort !== undefined && !this.manager) {
      if (!(await this.selfRegister(self))) return;
      this.mode = "self";
      this.manager = this.newManager(() => this.options.selfCredential?.(), selfPort);
      this.manager.start();
      this.options.log("tunnel: remote mode on, self-registered device; connecting to the relay");
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
      onStatus: () => this.options.onStatus?.(),
    });
  }

  /** Register the self credential's key at the relay once (idempotent there). */
  private async selfRegister(c: TunnelCredential): Promise<boolean> {
    const key = `${c.relayHost}/${c.deviceId}`;
    if (this.selfRegistered === key) return true;
    const origin = this.options.registerOrigin?.(c.relayHost) ?? `https://${c.relayHost}`;
    try {
      const res = await fetch(`${origin}/d/${c.deviceId}/self-register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: c.publicKey,
          proof: c.prove(selfRegistrationChallenge(c.deviceId)).toString("base64url"),
        }),
      });
      await res.text().catch(() => "");
      if (res.status === 200 || res.status === 201) {
        this.selfRegistered = key;
        return true;
      }
      this.options.log(`tunnel: self-registration refused (${res.status})`);
    } catch (error) {
      this.options.log(`tunnel: self-registration failed (${error instanceof Error ? error.message : String(error)})`);
    }
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
  }
}
