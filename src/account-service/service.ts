/** Cloud-only commercial admission. No dependency on Core or MCP payloads (AD-34). */
import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeviceId } from "../identity/device-id.js";
import {
  isDevicePublicKey,
  type DeviceRecord,
  type DeviceRegistry,
  type RegisterResult,
} from "../cloud-relay/registry.js";

export const PLANS = { free: 0, trial: 2, pro: 5, team: 20 } as const;
export type Plan = keyof typeof PLANS;
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "expired";
export interface Subscription {
  plan: Plan;
  status: SubscriptionStatus;
  expiresAt: number;
  subscriptionId?: string;
  updatedAt: number;
}
export interface BillingUpdate extends Subscription {
  accountId: string;
  eventId: string;
}
interface Account {
  subscription: Subscription;
  trialUsed: boolean;
  retiredSubscriptions?: string[];
  clients: { clientId: string; deviceId: string }[];
}
interface State {
  version: 1;
  accounts: Record<string, Account>;
  devices: Record<string, DeviceRecord>;
  revoked: Record<string, string>;
  events: Record<string, number>;
}
export interface AccountView {
  plan: Plan;
  status: SubscriptionStatus;
  remoteEnabled: boolean;
  entitled: boolean;
  maxDevices: number;
  deviceCount: number;
  expiresAt: number;
}
export class CommercialError extends Error {
  constructor(
    readonly code:
      | "entitlement_required"
      | "device_limit_reached"
      | "device_revoked"
      | "conflict"
      | "trial_used"
      | "not_found"
      | "invalid_billing_update",
  ) {
    super(code);
  }
}
export interface CommercialService extends DeviceRegistry {
  entitlement(record: DeviceRecord): Promise<"entitled" | "not_entitled" | "device_revoked">;
  subscribe(listener: (accountId: string, deviceId?: string) => void | Promise<void>): () => void;
  view(accountId: string): AccountView;
  deviceList(accountId: string): DeviceRecord[];
  clients(accountId: string): { clientId: string; deviceId: string }[];
  startTrial(accountId: string): Promise<void>;
  applyBilling(update: BillingUpdate): Promise<void>;
  revoke(accountId: string, deviceId: string): Promise<void>;
  noteClient(accountId: string, deviceId: string, clientId: string): Promise<void>;
  isRevoked(deviceId: string): boolean;
}
const empty = (): State => ({
  version: 1,
  accounts: Object.create(null),
  devices: Object.create(null),
  revoked: Object.create(null),
  events: Object.create(null),
});
const validId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[A-Za-z0-9_-]{1,256}$/.test(id) &&
  !["__proto__", "prototype", "constructor"].includes(id);
const validClient = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\x00-\x20]/.test(id);
const validSubscription = (s: Subscription) =>
  s &&
  Object.hasOwn(PLANS, s.plan) &&
  ["active", "past_due", "canceled", "expired"].includes(s.status) &&
  Number.isSafeInteger(s.expiresAt) &&
  s.expiresAt >= 0 &&
  Number.isSafeInteger(s.updatedAt) &&
  s.updatedAt >= 0 &&
  (s.subscriptionId === undefined || validId(s.subscriptionId));

/** Single-instance durable transactions; no registration/count TOCTOU. Multi-instance storage must implement this same interface atomically. */
export class AccountService implements CommercialService {
  private state: State = empty();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(accountId: string, deviceId?: string) => void | Promise<void>>();
  private constructor(
    private readonly file: string | undefined,
    private readonly now: () => number,
  ) {}
  static async open(file?: string, now: () => number = Date.now): Promise<AccountService> {
    const service = new AccountService(file, now);
    if (!file) return service;
    try {
      const state = JSON.parse(await readFile(file, "utf8")) as State;
      if (state.version !== 1 || !state.accounts || !state.devices || !state.revoked || !state.events)
        throw new Error("invalid commercial state");
      for (const [id, account] of Object.entries(state.accounts)) {
        if (
          !validId(id) ||
          !validSubscription(account.subscription) ||
          typeof account.trialUsed !== "boolean" ||
          (account.retiredSubscriptions !== undefined &&
            (!Array.isArray(account.retiredSubscriptions) ||
              account.retiredSubscriptions.some((id) => !validId(id)))) ||
          !Array.isArray(account.clients) ||
          account.clients.some((c) => !validClient(c.clientId) || !isDeviceId(c.deviceId))
        )
          throw new Error("invalid commercial account");
      }
      for (const [id, d] of Object.entries(state.devices))
        if (
          !isDeviceId(id) ||
          d.deviceId !== id ||
          !validId(d.accountId) ||
          !Object.hasOwn(state.accounts, d.accountId) ||
          !isDevicePublicKey(d.publicKey) ||
          !Number.isFinite(Date.parse(d.registeredAt)) ||
          typeof d.environment !== "string"
        )
          throw new Error("invalid commercial device");
      for (const [id, account] of Object.entries(state.revoked))
        if (!isDeviceId(id) || !validId(account) || Object.hasOwn(state.devices, id))
          throw new Error("invalid revocation state");
      for (const [id, time] of Object.entries(state.events))
        if (!validId(id) || !Number.isSafeInteger(time)) throw new Error("invalid billing ledger");
      service.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("commercial state unavailable");
    }
    return service;
  }
  subscribe(listener: (accountId: string, deviceId?: string) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private account(state: State, id: string): Account {
    if (!validId(id)) throw new CommercialError("not_found");
    if (!Object.hasOwn(state.accounts, id))
      state.accounts[id] = {
        subscription: { plan: "free", status: "active", expiresAt: 0, updatedAt: 0 },
        trialUsed: false,
        clients: [],
      };
    return state.accounts[id]!;
  }
  private async transaction<T>(change: (draft: State) => T, accountId: string, deviceId?: string): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = change(draft);
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${randomUUID()}.tmp`;
        try {
          const handle = await open(tmp, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(draft) + "\n");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(tmp, this.file);
        } finally {
          await rm(tmp, { force: true }).catch(() => undefined);
        }
      }
      this.state = draft;
      for (const listener of this.listeners) await listener(accountId, deviceId);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  view(accountId: string): AccountView {
    const s = Object.hasOwn(this.state.accounts, accountId)
      ? this.state.accounts[accountId]!.subscription
      : { plan: "free" as const, status: "active" as const, expiresAt: 0 };
    const status = s.plan !== "free" && s.expiresAt <= this.now() ? "expired" : s.status;
    const entitled = s.plan !== "free" && status === "active";
    return {
      plan: s.plan,
      status,
      remoteEnabled: entitled,
      entitled,
      maxDevices: PLANS[s.plan],
      deviceCount: this.deviceList(accountId).length,
      expiresAt: s.expiresAt,
    };
  }
  deviceList(accountId: string): DeviceRecord[] {
    return Object.values(this.state.devices)
      .filter((d) => d.accountId === accountId)
      .map((d) => structuredClone(d));
  }
  clients(accountId: string) {
    return Object.hasOwn(this.state.accounts, accountId)
      ? structuredClone(this.state.accounts[accountId]!.clients)
      : [];
  }
  isRevoked(deviceId: string): boolean {
    return Object.hasOwn(this.state.revoked, deviceId);
  }
  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return Object.hasOwn(this.state.devices, deviceId) ? this.state.devices[deviceId] : undefined;
  }
  async count(): Promise<number> {
    return Object.keys(this.state.devices).length;
  }
  async entitlement(record: DeviceRecord): Promise<"entitled" | "not_entitled" | "device_revoked"> {
    if (this.isRevoked(record.deviceId)) return "device_revoked";
    const current = await this.get(record.deviceId);
    if (!current || current.accountId !== record.accountId || current.publicKey.x !== record.publicKey.x)
      return "not_entitled";
    const view = this.view(record.accountId);
    // Downgrade keeps the earliest maxDevices registered devices. Never widens local authorization.
    const eligible = this.deviceList(record.accountId)
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.deviceId.localeCompare(b.deviceId))
      .slice(0, view.maxDevices);
    return view.entitled && eligible.some((d) => d.deviceId === record.deviceId) ? "entitled" : "not_entitled";
  }
  async register(record: DeviceRecord): Promise<RegisterResult> {
    if (
      !isDeviceId(record.deviceId) ||
      !validId(record.accountId) ||
      !isDevicePublicKey(record.publicKey) ||
      !/^[a-z0-9-]{1,32}$/.test(record.environment) ||
      !Number.isFinite(Date.parse(record.registeredAt))
    )
      throw new CommercialError("not_found");
    return this.transaction((state) => {
      if (Object.hasOwn(state.revoked, record.deviceId)) throw new CommercialError("device_revoked");
      const existing = state.devices[record.deviceId];
      if (existing && (existing.accountId !== record.accountId || existing.publicKey.x !== record.publicKey.x))
        return "conflict";
      const account = this.account(state, record.accountId);
      const s = account.subscription;
      if (s.plan === "free" || s.status !== "active" || s.expiresAt <= this.now())
        throw new CommercialError("entitlement_required");
      if (existing) return "unchanged";
      if (Object.values(state.devices).filter((d) => d.accountId === record.accountId).length >= PLANS[s.plan])
        throw new CommercialError("device_limit_reached");
      // Construct allowlisted metadata: no arbitrary input reaches persistence.
      state.devices[record.deviceId] = {
        deviceId: record.deviceId,
        accountId: record.accountId,
        publicKey: { kty: "OKP", crv: "Ed25519", x: record.publicKey.x },
        registeredAt: record.registeredAt,
        environment: record.environment,
      };
      return "created";
    }, record.accountId);
  }
  async remove(record: DeviceRecord): Promise<boolean> {
    return this.transaction(
      (state) => {
        const d = state.devices[record.deviceId];
        if (
          !d ||
          d.accountId !== record.accountId ||
          d.publicKey.x !== record.publicKey.x ||
          d.registeredAt !== record.registeredAt
        )
          return false;
        delete state.devices[record.deviceId];
        state.revoked[record.deviceId] = record.accountId;
        return true;
      },
      record.accountId,
      record.deviceId,
    );
  }
  async revoke(accountId: string, deviceId: string): Promise<void> {
    await this.transaction(
      (state) => {
        const d = state.devices[deviceId];
        if (!d || d.accountId !== accountId) throw new CommercialError("not_found");
        delete state.devices[deviceId];
        state.revoked[deviceId] = accountId;
      },
      accountId,
      deviceId,
    );
  }
  async startTrial(accountId: string): Promise<void> {
    await this.transaction((state) => {
      const a = this.account(state, accountId);
      if (a.trialUsed || a.subscription.subscriptionId || a.subscription.plan !== "free")
        throw new CommercialError("trial_used");
      a.trialUsed = true;
      a.subscription = {
        plan: "trial",
        status: "active",
        expiresAt: this.now() + 14 * 86400_000,
        updatedAt: 0,
      };
    }, accountId);
  }
  async applyBilling(update: BillingUpdate): Promise<void> {
    if (
      !validId(update.accountId) ||
      !validId(update.eventId) ||
      !validSubscription(update) ||
      !update.subscriptionId ||
      !["pro", "team"].includes(update.plan)
    )
      throw new CommercialError("invalid_billing_update");
    await this.transaction((state) => {
      if (Object.hasOwn(state.events, update.eventId)) return;
      const a = this.account(state, update.accountId);
      const old = a.subscription;
      if (
        Object.entries(state.accounts).some(
          ([id, account]) =>
            id !== update.accountId &&
            (account.subscription.subscriptionId === update.subscriptionId ||
              account.retiredSubscriptions?.includes(update.subscriptionId!)),
        )
      )
        throw new CommercialError("invalid_billing_update");
      if (a.retiredSubscriptions?.includes(update.subscriptionId!)) {
        state.events[update.eventId] = update.updatedAt;
        return;
      }
      if (old.subscriptionId && old.subscriptionId !== update.subscriptionId) {
        if ((old.status === "active" && old.expiresAt > this.now()) || update.updatedAt <= old.updatedAt)
          throw new CommercialError("invalid_billing_update");
        a.retiredSubscriptions = [...(a.retiredSubscriptions ?? []), old.subscriptionId];
      }
      // Stale events cannot reactivate canceled/expired plans. Equal timestamps may only narrow admission.
      const nextActive = update.status === "active" && update.expiresAt > this.now();
      const oldActive = old.status === "active" && old.expiresAt > this.now();
      const restrictive =
        !nextActive || (oldActive && PLANS[update.plan] <= PLANS[old.plan] && update.expiresAt <= old.expiresAt);
      if (update.updatedAt > old.updatedAt || (update.updatedAt === old.updatedAt && restrictive)) {
        a.subscription = {
          plan: update.plan,
          status: update.status,
          expiresAt: update.expiresAt,
          updatedAt: update.updatedAt,
          subscriptionId: update.subscriptionId,
        };
      }
      state.events[update.eventId] = update.updatedAt;
    }, update.accountId);
  }
  async noteClient(accountId: string, deviceId: string, clientId: string): Promise<void> {
    if (!validClient(clientId)) return;
    const known = this.clients(accountId).some((c) => c.deviceId === deviceId && c.clientId === clientId);
    if (known) return;
    await this.transaction((state) => {
      const d = state.devices[deviceId];
      if (!d || d.accountId !== accountId) return;
      const a = this.account(state, accountId);
      if (!a.clients.some((c) => c.deviceId === deviceId && c.clientId === clientId)) {
        if (a.clients.length >= 1000) a.clients.shift();
        a.clients.push({ deviceId, clientId });
      }
    }, accountId);
  }
}
