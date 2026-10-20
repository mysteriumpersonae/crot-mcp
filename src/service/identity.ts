/**
 * The device's identity runtime in the service (ARCHITECTURE.md §27, AD-21;
 * WP-28): the identity environment of this process, the issuer's keys, the
 * relay entry point's token verifier, the device's Protected Resource
 * Metadata URL, the tunnel credential and the pairing flow in progress.
 *
 * It holds no policy: pairing and unpairing are applied (and audited) by the
 * control center for requests on the control channel; remote requests are
 * admitted by the control center and authorized by Core. Nothing here
 * reaches Core except, through the verifier, the verified facts of a token.
 *
 * Pairing registers the new device at the relay (AD-22 point 4; WP-30): the
 * device key and an inactive rollback intent are durably verified before
 * registration; failures compensate with a fresh signed removal request.
 */
import type { AccountView } from "../account-service/service.js";
import type { RemoteClientKey } from "../adapters/http/server.js";
import type { AccessTokenVerifier } from "../adapters/http/auth.js";
import { canonicalDeviceUri, generateDeviceId, protectedResourceMetadataUrl } from "../identity/device-id.js";
import type { IdentityEnvironment } from "../identity/environment.js";
import { createIdentityHttp, type IdentityHttp } from "../identity/http.js";
import { IssuerKeySet } from "../identity/jwks.js";
import { devicePublicKey, deviceKeyFromSeed } from "../identity/device-credential.js";
import { startPairing, type PairingFlow, type PairingOutcome } from "../identity/pairing.js";
import {
  deregisterDeviceAtRelay,
  registerDeviceAtRelay,
  relayRegistrationUrl,
} from "../identity/relay-registration.js";
import { OAuthAccessTokenVerifier, UnavailableTokenVerifier, type TokenRejection } from "../identity/verifier.js";
import type { DeviceBindingStore, TunnelCredentialResult } from "./device-binding.js";
import { generateSecret } from "./secrets/store.js";

export interface DeviceIdentityOptions {
  /** The environment of this process, or why there is none. */
  readonly environment: IdentityEnvironment | { readonly unavailable: string };
  readonly binding: DeviceBindingStore;
  readonly http?: IdentityHttp;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  /** JWKS cache tuning (tests). */
  readonly keys?: { readonly minRefetchIntervalMs?: number; readonly maxAgeMs?: number; readonly maxStaleMs?: number };
  readonly pairingTimeoutMs?: number;
}

export interface PendingPairing {
  readonly deviceId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export class DeviceIdentity {
  readonly environment: IdentityEnvironment | undefined;
  readonly unavailableReason: string | undefined;
  readonly verifier: AccessTokenVerifier;
  private readonly keys: IssuerKeySet | undefined;
  private readonly http: IdentityHttp;
  private flow: PairingFlow | undefined;
  private registration: Promise<unknown> | undefined;
  private recovery: Promise<boolean> = Promise.resolve(true);
  private readonly rejections = new Map<TokenRejection, number>();

  constructor(private readonly options: DeviceIdentityOptions) {
    this.http = options.http ?? createIdentityHttp();
    if ("unavailable" in options.environment) {
      this.environment = undefined;
      this.unavailableReason = options.environment.unavailable;
      this.keys = undefined;
      this.verifier = new UnavailableTokenVerifier();
      return;
    }
    const environment = options.environment;
    this.environment = environment;
    this.unavailableReason = undefined;
    this.keys = new IssuerKeySet({
      issuer: environment.issuer,
      http: this.http,
      ...(options.now ? { now: options.now } : {}),
      ...options.keys,
      onError: (m) => options.log(m),
    });
    this.verifier = new OAuthAccessTokenVerifier({
      environment,
      keys: this.keys,
      binding: () => options.binding.view(),
      ...(options.now ? { now: options.now } : {}),
      onReject: (reason) => {
        this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
        options.log(`identity: rejected a remote access token (${reason})`);
      },
    });
    this.recovery = this.rollbackPairing();
  }

  commercialStatus: (AccountView & { checkedAt: string }) | undefined;
  private commercialChecked = 0;
  private commercialDeviceId: string | undefined;
  private commercialPending: Promise<void> | undefined;

  /** Explicit owner overview request; no background diagnostics or payload uploads. */
  refreshCommercialStatus(): Promise<void> {
    if (this.commercialPending) return this.commercialPending;
    const binding = this.options.binding.view();
    if (binding.state !== "paired" || binding.deviceId !== this.commercialDeviceId) {
      this.commercialStatus = undefined;
      this.commercialChecked = 0;
      this.commercialDeviceId = binding.state === "paired" ? binding.deviceId : undefined;
    }
    if (binding.state !== "paired") return Promise.resolve();
    const requestedDeviceId = binding.deviceId;
    const now = (this.options.now ?? Date.now)();
    if (now - this.commercialChecked < 30_000) return Promise.resolve();
    this.commercialChecked = now;
    this.commercialPending = this.commercialRequest("status")
      .then((result) => {
        const current = this.options.binding.view();
        if (current.state !== "paired" || current.deviceId !== requestedDeviceId) {
          this.commercialStatus = undefined;
          return;
        }
        const v = result as AccountView;
        if (
          !v ||
          !["free", "trial", "pro", "team"].includes(v.plan) ||
          !["active", "past_due", "canceled", "expired"].includes(v.status) ||
          typeof v.entitled !== "boolean" ||
          typeof v.remoteEnabled !== "boolean" ||
          !Number.isSafeInteger(v.deviceCount) ||
          !Number.isSafeInteger(v.maxDevices) ||
          !Number.isFinite(v.expiresAt)
        )
          throw new Error("invalid commercial status");
        this.commercialStatus = {
          plan: v.plan,
          status: v.status,
          entitled: v.entitled,
          remoteEnabled: v.remoteEnabled,
          deviceCount: v.deviceCount,
          maxDevices: v.maxDevices,
          expiresAt: v.expiresAt,
          checkedAt: new Date(now).toISOString(),
        };
      })
      .catch(() => {
        this.commercialStatus = undefined;
      })
      .finally(() => {
        this.commercialPending = undefined;
      });
    return this.commercialPending;
  }

  async revokeAtProvider(client: RemoteClientKey): Promise<"requested" | "not_available" | "failed"> {
    try {
      const { accountId, deviceId, clientId } = client;
      const binding = this.options.binding.view();
      if (binding.state !== "paired" || binding.accountId !== accountId || binding.deviceId !== deviceId)
        return "not_available";
      const result = (await this.commercialRequest("revoke_client", clientId)) as { provider?: string };
      return result?.provider === "requested"
        ? "requested"
        : result?.provider === "not_available"
          ? "not_available"
          : "failed";
    } catch {
      return "failed";
    }
  }

  private async commercialRequest(action: "status" | "revoke_client", clientId = ""): Promise<unknown> {
    const credential = this.options.binding.commercialCredential(this.environment);
    if (!credential || !this.http.postJsonResult) throw new Error("commercial_unavailable");
    const base = `https://${credential.relayHost}/d/${credential.deviceId}/account`;
    const c = await this.http.postJsonResult(base + "/challenge", { action, clientId });
    const challenge = (c.body as { challenge?: string })?.challenge;
    if (c.status !== 200 || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new Error("commercial_unavailable");
    const proof = credential.prove(Buffer.from(challenge, "base64url"), action, clientId).toString("base64url");
    const r = await this.http.postJsonResult(base, { action, clientId, challenge, proof });
    if (r.status !== 200) throw new Error("commercial_unavailable");
    return r.body;
  }

  /** Token rejections since start, by reason (diagnostics). */
  get rejectionCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.rejections);
  }

  /** RFC 9207 support as advertised by the issuer (reported only; AD-21 R7 open condition). */
  get rfc9207(): "advertised" | "not_advertised" | "unknown" {
    const supported = this.keys?.status().issParameterSupported;
    return supported === undefined ? "unknown" : supported ? "advertised" : "not_advertised";
  }

  /** The canonical URI of the paired device in the active environment (AD-21 point 5). */
  resourceUri(): string | undefined {
    const paired = this.pairedHere();
    return paired ? canonicalDeviceUri(paired.relayHost, paired.deviceId) : undefined;
  }

  /** The device's PRM URL for 401 challenges (AD-21 point 6); undefined while not paired here. */
  resourceMetadataUrl(): string | undefined {
    const paired = this.pairedHere();
    return paired ? protectedResourceMetadataUrl(paired.relayHost, paired.deviceId) : undefined;
  }

  tunnelCredential(): TunnelCredentialResult {
    return this.options.binding.tunnelCredential(this.environment);
  }

  get pending(): PendingPairing | undefined {
    const flow = this.flow;
    return flow
      ? { deviceId: flow.deviceId, authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt }
      : undefined;
  }

  /**
   * Start a pairing for a new device id. `onOutcome` runs once when the user
   * signed in (or the flow failed, timed out or was cancelled).
   */
  async startPairing(onOutcome: (outcome: PairingOutcome, deviceId: string) => void): Promise<PendingPairing> {
    if (!this.environment || !this.keys) throw new Error(this.unavailableReason ?? "no identity environment");
    if (this.flow) return this.pending!;
    await this.recovery;
    if (!(await this.rollbackPairing())) throw new Error("pending relay registration cleanup unavailable; retry later");
    const metadata = await this.keys.metadata();
    const environment = this.environment;
    const deviceId = generateDeviceId();
    const seed = generateSecret();
    const publicKey = devicePublicKey(deviceKeyFromSeed(seed));
    const flow = await startPairing({
      environment,
      metadata,
      http: this.http,
      keys: this.keys,
      deviceId,
      register: (accessToken) => {
        const run = async () => {
          await this.options.binding.prepareRegistration(deviceId, seed, environment.relayHost);
          const result = await registerDeviceAtRelay({
            http: this.http,
            url: relayRegistrationUrl(environment.relayHost, deviceId),
            accessToken,
            publicKey,
          });
          if (!result.ok) {
            const detail = `${result.reason}${result.status !== undefined ? ` (status ${result.status})` : ""}`;
            this.options.log(`identity: the relay did not register the device: ${detail}`);
            return { ok: false as const, detail };
          }
          this.options.binding.stageDeviceKey(deviceId, seed);
          this.options.log(`identity: device ${result.created ? "registered" : "already registered"} at the relay`);
          return { ok: true as const };
        };
        const pending = run();
        this.registration = pending;
        return pending;
      },
      ...(this.options.pairingTimeoutMs !== undefined ? { timeoutMs: this.options.pairingTimeoutMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    this.flow = flow;
    void flow.outcome.then(async (outcome) => {
      if (!outcome.ok) {
        await this.registration?.catch(() => undefined);
        await this.rollbackPairing(flow.deviceId);
        this.options.binding.clearStagedKey(flow.deviceId);
      }
      if (this.flow === flow) this.flow = undefined;
      onOutcome(outcome, flow.deviceId);
    });
    return this.pending!;
  }

  /** Compensation survives a failed final binding write via a durable inactive intent. */
  async rollbackPairing(deviceId?: string): Promise<boolean> {
    try {
      const pending = await this.options.binding.pendingRegistration();
      if (!pending || (deviceId !== undefined && pending.deviceId !== deviceId)) return true;
      if (!(await deregisterDeviceAtRelay(this.http, pending))) {
        this.options.log("identity: registration cleanup pending; retry pairing when relay is reachable");
        return false;
      }
      await this.options.binding.clearRegistration();
      return true;
    } catch {
      this.options.log("identity: registration cleanup failed; durable intent retained");
      return false;
    }
  }
  /** Capture a removal-only signer before local unpair destroys the device credential. */
  prepareDeregistration(): () => Promise<void> {
    const credential = this.options.binding.removalCredential();
    return async () => {
      if (credential && !(await deregisterDeviceAtRelay(this.http, credential)))
        this.options.log("identity: best-effort relay deregistration unavailable; local device remains unpaired");
    };
  }

  cancelPairing(): boolean {
    if (!this.flow) return false;
    this.flow.cancel();
    return true;
  }

  private pairedHere() {
    const env = this.environment;
    const paired = this.options.binding.paired;
    if (!env || !paired || paired.issuer !== env.issuer || paired.relayHost !== env.relayHost) return undefined;
    return paired;
  }
}
