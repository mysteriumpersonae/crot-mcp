import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../../src/account-service/service.js";
import { StripeBillingProvider } from "../../src/account-service/billing.js";
import { signCommercialProof } from "../../src/identity/device-credential.js";
import { ACCOUNT_PATH } from "../../src/account-service/http.js";
import { PAIRING_CLIENT, TEST_RELAY, MCP_CLIENT } from "../identity/test-authorization-server.js";
import { RelayHarness, waitFor } from "../cloud-relay/harness.js";
import type { PairedDevice } from "../cloud-relay/harness.js";
let h: RelayHarness;
let accounts: AccountService;
const provider = { revoke: vi.fn(async () => "requested" as const) };
const secret = "whsec_fixture_only";
let eventTime: number;
beforeEach(async () => {
  accounts = await AccountService.open();
  eventTime = Math.floor(Date.now() / 1000);
  provider.revoke.mockClear();
  h = await new RelayHarness().start({
    accounts,
    registry: accounts,
    provider,
    billing: new StripeBillingProvider({
      webhookSecret: secret,
      prices: { pro: "price_pro", team: "price_team" },
      returnUrl: "https://crot.example/portal",
    }),
  });
});
afterEach(async () => h.stop());
const ownerToken = (sub = "user_01") =>
  h.as.token({ resource: `https://${TEST_RELAY}${ACCOUNT_PATH}`, sub, clientId: PAIRING_CLIENT });
const owner = (suffix = "", method = "GET", body?: object, sub = "user_01") =>
  fetch(h.origin + ACCOUNT_PATH + suffix, {
    method,
    headers: { authorization: `Bearer ${ownerToken(sub)}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function bill(status = "active", plan = "pro", expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  eventTime++;
  const raw = Buffer.from(
    JSON.stringify({
      id: `evt_${eventTime}`,
      created: eventTime,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_01",
          status,
          metadata: { accountId: "user_01" },
          current_period_end: expiresAt,
          items: { data: [{ price: { id: "price_" + plan } }] },
        },
      },
    }),
  );
  const time = Math.floor(Date.now() / 1000);
  const signature = `t=${time},v1=${createHmac("sha256", secret).update(`${time}.`).update(raw).digest("hex")}`;
  const response = await fetch(h.origin + "/.crot/billing/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: raw,
  });
  expect(response.status).toBe(200);
}
async function signed(d: PairedDevice, action: "status" | "revoke_client", clientId = "") {
  const base = h.origin + `/d/${d.deviceId}/account`;
  const c = await fetch(base + "/challenge", { method: "POST", body: JSON.stringify({ action, clientId }) });
  const { challenge } = (await c.json()) as { challenge: string };
  const proof = signCommercialProof(
    d.key,
    d.deviceId,
    TEST_RELAY,
    Buffer.from(challenge, "base64url"),
    action,
    clientId,
  ).toString("base64url");
  return { base, body: { action, clientId, challenge, proof } };
}
describe("WP-36 real relay admission, billing and lost-device lifecycle", () => {
  it("registration refuses free accounts, trial enforces maxDevices with clear 403", async () => {
    const d = h.newDevice();
    const r = await h.registerRaw(d.deviceId, h.pairingToken(d), { publicKey: d.publicKey });
    expect(r).toMatchObject({ status: 403, body: { error: "entitlement_required" } });
    expect((await owner("/trial", "POST")).status).toBe(200);
    await h.register(d);
    await h.register(h.newDevice());
    const extra = h.newDevice();
    expect(await h.registerRaw(extra.deviceId, h.pairingToken(extra), { publicKey: extra.publicKey })).toMatchObject({
      status: 403,
      body: { error: "device_limit_reached" },
    });
    const view = await (await owner()).json();
    expect(view).toMatchObject({ plan: "trial", maxDevices: 2, deviceCount: 2, entitled: true });
  });
  it("signed cancellation closes active tunnel 4403 and returns HTTP 403/not_executed", async () => {
    await bill();
    const { paired, device } = await h.ready();
    await bill("canceled");
    expect(await device.whenClosed()).toMatchObject({ code: 4403, reason: "not_entitled" });
    const res = await h.post(paired);
    expect(res.status).toBe(403);
    expect(res.headers.get("CROT-Request-Outcome")).toBe("not_executed");
    expect((await (await h.connect(paired)).whenClosed()).code).toBe(4403);
    expect(device.opened).toHaveLength(0);
  });
  it("wall-clock expiry closes active tunnel without another webhook", async () => {
    await bill("active", "pro", Math.floor(Date.now() / 1000) + 2);
    const { paired, device } = await h.ready();
    await waitFor(() => device.closed !== undefined, 5000);
    expect(device.closed).toMatchObject({ code: 4403, reason: "not_entitled" });
    expect((await h.post(paired)).status).toBe(403);
  });
  it("team->pro webhook closes only excess devices and prevents new registrations", async () => {
    await bill("active", "team");
    const ready = [];
    for (let i = 0; i < 6; i++) ready.push(await h.ready());
    await bill("active", "pro");
    await waitFor(() => h.relay.status().devicesOnline === 5);
    expect(ready.filter((r) => h.relay.isOnline(r.paired.deviceId))).toHaveLength(5);
    const extra = h.newDevice();
    expect(
      (await h.registerRaw(extra.deviceId, h.pairingToken(extra), { publicKey: extra.publicKey })).body.error,
    ).toBe("device_limit_reached");
  });
  it("owner-only lost-device revocation removes key, PRM and all future tunnel/MCP admission", async () => {
    await bill();
    const { paired, device } = await h.ready();
    expect((await owner(`/devices/${paired.deviceId}`, "DELETE", undefined, "other_account")).status).toBe(404);
    expect(h.relay.isOnline(paired.deviceId)).toBe(true);
    expect((await owner(`/devices/${paired.deviceId}`, "DELETE")).status).toBe(200);
    expect(await device.whenClosed()).toEqual({ code: 4403, reason: "device_revoked" });
    expect(await accounts.get(paired.deviceId)).toBeUndefined();
    expect((await fetch(`${h.origin}/.well-known/oauth-protected-resource/d/${paired.deviceId}/mcp`)).status).toBe(404);
    expect((await h.post(paired)).status).toBe(404);
    expect((await (await h.connect(paired)).whenClosed()).code).toBe(4403);
    expect(
      (await h.registerRaw(paired.deviceId, h.pairingToken(paired), { publicKey: paired.publicKey })).body.error,
    ).toBe("device_revoked");
  });
  it("MCP/device tokens and foreign first-party clients cannot administer an account", async () => {
    const d = h.newDevice();
    for (const token of [
      h.clientToken(d),
      h.pairingToken(d),
      h.as.token({ resource: `https://${TEST_RELAY}${ACCOUNT_PATH}`, sub: "user_01", clientId: "untrusted_client" }),
      "bad",
    ]) {
      const r = await fetch(h.origin + ACCOUNT_PATH + "/trial", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(401);
    }
    expect(accounts.view("user_01").plan).toBe("free");
  });
  it("signed device status and provider revocation bind purpose/client/device, reject replays", async () => {
    await bill();
    const { paired } = await h.ready();
    await accounts.noteClient(paired.accountId, paired.deviceId, MCP_CLIENT);
    const status = await signed(paired, "status");
    const send = (body: unknown) => fetch(status.base, { method: "POST", body: JSON.stringify(body) });
    expect((await send(status.body)).status).toBe(200);
    expect((await send(status.body)).status).toBe(403);
    const revoke = await signed(paired, "revoke_client", MCP_CLIENT);
    expect(await (await fetch(revoke.base, { method: "POST", body: JSON.stringify(revoke.body) })).json()).toEqual({
      provider: "requested",
    });
    expect(provider.revoke).toHaveBeenCalledWith(paired.accountId, MCP_CLIENT);
    const altered = await signed(paired, "status");
    expect((await send({ ...altered.body, action: "revoke_client", clientId: MCP_CLIENT })).status).toBe(403);
    expect(provider.revoke).toHaveBeenCalledTimes(1);
    const pending = await signed(paired, "status");
    await accounts.revoke(paired.accountId, paired.deviceId);
    expect((await send(pending.body)).status).toBe(404);
  });
  it("no commercial interface receives MCP payloads, paths or headers and operational logs omit them", async () => {
    await bill();
    const { paired, device } = await h.ready({
      onOpen(stream) {
        stream.respond(200, [["content-type", "application/json"]]);
        void stream.write(Buffer.from("{}"), true);
      },
    });
    const spy = vi.spyOn(accounts, "noteClient");
    const canary = "PRIVATE_PROJECT_BODY_CANARY";
    const response = await h.post(
      paired,
      JSON.stringify({ path: "/private/project/" + canary, url: "https://private.example/" + canary }),
      { "x-private": canary },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(device.opened).toHaveLength(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(accounts.clients(paired.accountId))).not.toContain(canary);
    expect(h.logText()).not.toContain(canary);
    expect(h.logText()).not.toContain(h.clientToken(paired));
  });
  it("minimum device software is a 4426 update-admission rule, not account/local authorization", async () => {
    await h.stop();
    h = await new RelayHarness().start({ accounts, registry: accounts, minimumDeviceVersion: "1.0.0" });
    await accounts.startTrial("user_01");
    const d = h.newDevice();
    await h.register(d);
    expect(await (await h.connect(d)).whenClosed()).toEqual({ code: 4426, reason: "update required" });
    expect(accounts.view("user_01").entitled).toBe(true);
  });
});
