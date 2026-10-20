import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider } from "../../src/account-service/billing.js";
import { WorkOSAuthorizationProvider } from "../../src/account-service/provider.js";
const now = 1_800_000_000_000;
const options = {
  webhookSecret: "whsec_fixture_only",
  prices: { pro: "price_pro", team: "price_team" },
  returnUrl: "https://crot.example/portal",
  now: () => now,
};
const event = (status = "active", price = "price_pro") =>
  Buffer.from(
    JSON.stringify({
      id: "evt_01",
      created: now / 1000,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_01",
          status,
          metadata: { accountId: "user_01" },
          current_period_end: now / 1000 + 3600,
          items: { data: [{ price: { id: price } }] },
        },
      },
    }),
  );
const signature = (raw: Buffer, timestamp = now / 1000) =>
  `t=${timestamp},v1=${createHmac("sha256", options.webhookSecret)
    .update(String(timestamp) + ".")
    .update(raw)
    .digest("hex")}`;
describe("signed billing and server-only provider credentials", () => {
  it("verifies raw Stripe signature and maps trusted prices/status/expiry", () => {
    const p = new StripeBillingProvider(options);
    const raw = event();
    expect(p.verify(raw, signature(raw))).toMatchObject({
      accountId: "user_01",
      plan: "pro",
      status: "active",
      subscriptionId: "sub_01",
    });
    for (const status of ["canceled", "past_due", "incomplete_expired"]) {
      const bytes = event(status, "price_team");
      expect(p.verify(bytes, signature(bytes))).toMatchObject({
        plan: "team",
        status: status === "incomplete_expired" ? "expired" : status,
      });
    }
  });
  it("rejects forged, missing, stale, future, duplicate timestamp, modified-body and unmapped-price webhooks", () => {
    const p = new StripeBillingProvider(options);
    const raw = event();
    for (const s of [
      undefined,
      "v1=00",
      signature(raw, now / 1000 - 301),
      signature(raw, now / 1000 + 301),
      signature(raw) + ",t=123",
    ])
      expect(() => p.verify(raw, s)).toThrow();
    expect(() => p.verify(Buffer.concat([raw, Buffer.from(" ")]), signature(raw))).toThrow();
    const unknown = event("active", "price_unapproved");
    expect(() => p.verify(unknown, signature(unknown))).toThrow();
  });
  it("checkout sets account metadata and price on the server, never accepts arbitrary redirect/price", async () => {
    const request = vi.fn(
      async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay_fixture" })),
    );
    const p = new StripeBillingProvider({ ...options, apiKey: "server_only_key", fetch: request as typeof fetch });
    expect(await p.checkout("user_01", "pro")).toContain("checkout.stripe.com");
    const call = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.stripe.com/v1/checkout/sessions");
    const form = new URLSearchParams(call[1].body as string);
    expect(form.get("subscription_data[metadata][accountId]")).toBe("user_01");
    expect(form.get("line_items[0][price]")).toBe("price_pro");
    expect(form.get("success_url")).toBe(options.returnUrl);
  });
  it("WorkOS deletes only the user's authorization, not the shared application, and bounds failures", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const p = new WorkOSAuthorizationProvider("server_only_key", request as typeof fetch);
    expect(await p.revoke("user_01", "client_01")).toBe("requested");
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/user_management/users/user_01/authorized_applications/client_01");
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("DELETE");
    const failed = new WorkOSAuthorizationProvider("server_only_key", (async () => {
      throw new Error("private payload must not escape");
    }) as typeof fetch);
    expect(await failed.revoke("user_01", "client_01")).toBe("failed");
  });
});
