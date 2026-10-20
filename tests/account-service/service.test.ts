import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { AccountService, PLANS, type BillingUpdate } from "../../src/account-service/service.js";
import { devicePublicKey } from "../../src/identity/device-credential.js";
import { generateDeviceId } from "../../src/identity/device-id.js";
import { makeTempDirs } from "../helpers.js";
const record = (accountId = "user_01") => ({
  deviceId: generateDeviceId(),
  accountId,
  publicKey: devicePublicKey(generateKeyPairSync("ed25519").privateKey),
  environment: "test",
  registeredAt: new Date().toISOString(),
});
const update = (extra: Partial<BillingUpdate> = {}): BillingUpdate => ({
  accountId: "user_01",
  plan: "pro",
  status: "active",
  expiresAt: Date.now() + 86400_000,
  subscriptionId: "sub_01",
  updatedAt: Date.now(),
  eventId: "evt_1",
  ...extra,
});
describe("commercial admission (never Core authorization)", () => {
  it("free is accountless and never entitled", async () => {
    const s = await AccountService.open();
    expect(s.view("unknown")).toMatchObject({ plan: "free", remoteEnabled: false, maxDevices: 0, deviceCount: 0 });
    await expect(s.register(record())).rejects.toMatchObject({ code: "entitlement_required" });
    expect(await s.count()).toBe(0);
    expect(PLANS).toEqual({ free: 0, trial: 2, pro: 5, team: 20 });
  });
  it("trial is 14 days, once per account, with an atomic two-device limit", async () => {
    let now = Date.now();
    const s = await AccountService.open(undefined, () => now);
    await s.startTrial("user_01");
    expect(s.view("user_01").expiresAt).toBe(now + 14 * 86400_000);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => s.register(record())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(18);
    now += 14 * 86400_000;
    expect(s.view("user_01")).toMatchObject({ status: "expired", entitled: false });
    await expect(s.startTrial("user_01")).rejects.toMatchObject({ code: "trial_used" });
  });
  it("idempotence does not consume slots, cross-account/key overwrite conflicts", async () => {
    const s = await AccountService.open();
    await s.applyBilling(update());
    const r = record();
    expect(await s.register(r)).toBe("created");
    expect(await s.register(r)).toBe("unchanged");
    expect(await s.register({ ...r, accountId: "user_02" })).toBe("conflict");
    expect(await s.register({ ...r, publicKey: record().publicKey })).toBe("conflict");
    expect(s.view("user_01").deviceCount).toBe(1);
  });
  it("cancellation, expiry and past_due deny admission, stale/replayed events never reactivate", async () => {
    const s = await AccountService.open();
    const u = update();
    await s.applyBilling(u);
    const r = record();
    await s.register(r);
    expect(await s.entitlement(r)).toBe("entitled");
    await s.applyBilling({ ...u, status: "canceled", eventId: "evt_cancel", updatedAt: u.updatedAt + 1 });
    await s.applyBilling(u);
    await s.applyBilling({ ...u, eventId: "evt_old" });
    expect(await s.entitlement(r)).toBe("not_entitled");
    await s.applyBilling({ ...u, eventId: "evt_new", updatedAt: u.updatedAt + 2 });
    expect(await s.entitlement(r)).toBe("entitled");
    await s.applyBilling({ ...u, status: "past_due", eventId: "evt_past_due", updatedAt: u.updatedAt + 3 });
    expect(await s.entitlement(r)).toBe("not_entitled");
  });
  it("team->pro downgrade deterministically limits existing devices without deleting registrations", async () => {
    const s = await AccountService.open();
    const u = update({ plan: "team" });
    await s.applyBilling(u);
    const devices = Array.from({ length: 7 }, () => record());
    for (const r of devices) await s.register(r);
    await s.applyBilling({ ...u, plan: "pro", updatedAt: u.updatedAt + 1, eventId: "evt_down" });
    expect((await Promise.all(devices.map((d) => s.entitlement(d)))).filter((v) => v === "entitled")).toHaveLength(5);
    await expect(s.register(record())).rejects.toMatchObject({ code: "device_limit_reached" });
    expect(s.deviceList("user_01")).toHaveLength(7);
  });
  it("lost-device tombstones survive restart, delete public key and prevent re-registration", async () => {
    const dirs = await makeTempDirs();
    const file = path.join(dirs.outside, "accounts.json");
    try {
      const s = await AccountService.open(file);
      await s.applyBilling(update());
      const r = record();
      await s.register(r);
      await expect(s.revoke("user_02", r.deviceId)).rejects.toMatchObject({ code: "not_found" });
      await s.revoke("user_01", r.deviceId);
      const restarted = await AccountService.open(file);
      expect(await restarted.get(r.deviceId)).toBeUndefined();
      expect(await restarted.entitlement(r)).toBe("device_revoked");
      await expect(restarted.register(r)).rejects.toMatchObject({ code: "device_revoked" });
      expect(await readFile(file, "utf8")).not.toContain(r.publicKey.x);
    } finally {
      await dirs.cleanup();
    }
  });
  it("only allowlisted account/device/client metadata is persisted", async () => {
    const dirs = await makeTempDirs();
    const file = path.join(dirs.outside, "accounts.json");
    try {
      const s = await AccountService.open(file);
      await s.applyBilling({ ...update(), body: "MCP_BODY_CANARY" } as BillingUpdate);
      await s.register({
        ...record(),
        filePath: "/private/project/CANARY",
        tabUrl: "https://private.example/CANARY",
      } as ReturnType<typeof record>);
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain("tabUrl");
      expect(text).not.toContain("filePath");
    } finally {
      await dirs.cleanup();
    }
  });
  it("persistence failure rolls back state and malformed durable state fails closed", async () => {
    const dirs = await makeTempDirs();
    const file = path.join(dirs.outside, "state");
    try {
      const s = await AccountService.open(file);
      await mkdir(file);
      await expect(s.startTrial("user_01")).rejects.toThrow();
      expect(s.view("user_01").plan).toBe("free");
      const corrupt = path.join(dirs.outside, "corrupt");
      await writeFile(corrupt, "{}");
      await expect(AccountService.open(corrupt)).rejects.toThrow("commercial state unavailable");
    } finally {
      await dirs.cleanup();
    }
  });
  it("same-second downgrade cannot reactivate cancellation, retired subscriptions cannot reactivate or change owners", async () => {
    const s = await AccountService.open();
    const u = update({ plan: "team" });
    await s.applyBilling(u);
    await s.applyBilling({ ...u, status: "canceled", eventId: "evt_cancel" });
    await s.applyBilling({ ...u, plan: "pro", eventId: "evt_same_second" });
    expect(s.view("user_01").entitled).toBe(false);
    await s.applyBilling({ ...u, subscriptionId: "sub_new", eventId: "evt_rebuy", updatedAt: u.updatedAt + 1 });
    expect(s.view("user_01").entitled).toBe(true);
    await s.applyBilling({ ...u, status: "canceled", eventId: "evt_retired", updatedAt: u.updatedAt + 2 });
    expect(s.view("user_01").entitled).toBe(true);
    await expect(
      s.applyBilling({
        ...u,
        subscriptionId: "sub_new",
        accountId: "user_02",
        eventId: "evt_transfer",
        updatedAt: u.updatedAt + 3,
      }),
    ).rejects.toMatchObject({ code: "invalid_billing_update" });
  });
});
