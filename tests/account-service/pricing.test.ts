import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PLAN_CATALOG } from "../../src/account-service/catalog.js";
import { StripeBillingProvider } from "../../src/account-service/billing.js";

describe("Owner-approved Pro price", () => {
  it("advertises USD 5 per month and seven trial days", () => {
    expect(PLAN_CATALOG.pro).toEqual({
      monthlyUsdCents: 500,
      annualUsdCents: 3900,
      founderAnnualUsdCents: 2900,
      currency: "usd",
      interval: "month",
      trialDays: 7,
    });
  });
  it.each([
    { unit_amount: 1500 },
    { currency: "eur" },
    { active: false },
    { id: "price_other" },
    { recurring: { interval: "year", interval_count: 1 } },
    { recurring: { interval: "month", interval_count: 3 } },
  ])("rejects mismatched configured Stripe price before opening Checkout: %j", async (override) => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json({
        id: "price_pro",
        active: true,
        unit_amount: 500,
        currency: "usd",
        recurring: { interval: "month", interval_count: 1 },
        ...override,
      }),
    );
    const provider = new StripeBillingProvider({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      prices: { pro: "price_pro", team: "price_team" },
      returnUrl: "https://crot.example/portal",
      fetch: fetcher,
    });
    await expect(provider.checkout("user_price", "trial")).rejects.toThrow("USD 5 per month");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("checkout");
  });
});

describe("Pro billing terms stay server-authoritative", () => {
  const prices = {
    pro: "price_monthly",
    team: "price_legacy",
    proAnnual: "price_annual",
    proFounderAnnual: "price_founder",
  };
  function fixture(amount: number, interval: string, priceId: string) {
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        String(input).includes("/prices/")
          ? {
              id: priceId,
              active: true,
              unit_amount: amount,
              currency: "usd",
              recurring: { interval, interval_count: 1 },
            }
          : { url: "https://checkout.stripe.com/test" },
      ),
    );
    const provider = new StripeBillingProvider({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      prices,
      returnUrl: "https://crot.network/portal",
      fetch: fetcher,
    });
    return { provider, fetcher };
  }
  it.each([
    ["monthly", 500, "month", "price_monthly"],
    ["annual", 3900, "year", "price_annual"],
    ["founderAnnual", 2900, "year", "price_founder"],
  ] as const)(
    "verifies the live %s amount, currency and interval before checkout",
    async (term, amount, interval, id) => {
      const { provider, fetcher } = fixture(amount, interval, id);
      await expect(provider.checkout("account_1", "pro", term)).resolves.toBe("https://checkout.stripe.com/test");
      expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.stripe.com/v1/prices/" + id);
      const init = fetcher.mock.calls[1]?.[1];
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("line_items[0][price]")).toBe(id);
      expect(body.get("subscription_data[trial_period_days]")).toBeNull();
      expect(init?.redirect).toBe("error");
    },
  );
  it.each([
    [300, "month"],
    [500, "month"],
    [2900, "year"],
    [3900, "month"],
  ])("rejects stale/other-term annual price %s %s before checkout", async (amount, interval) => {
    const { provider, fetcher } = fixture(Number(amount), String(interval), "price_annual");
    await expect(provider.checkout("account_1", "pro", "annual")).rejects.toThrow("USD 39 per year");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fails closed for unconfigured annual/founder terms and ambiguous IDs", async () => {
    const fetcher = vi.fn();
    const options = {
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
      prices: { pro: "price_monthly", team: "price_legacy" },
      returnUrl: "https://crot.network/portal",
      fetch: fetcher,
    };
    const provider = new StripeBillingProvider(options);
    await expect(provider.checkout("account_1", "pro", "annual")).rejects.toThrow("not configured");
    await expect(provider.checkout("account_1", "trial", "founderAnnual")).rejects.toThrow("invalid billing term");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () => new StripeBillingProvider({ ...options, prices: { ...options.prices, proAnnual: "price_monthly" } }),
    ).toThrow("invalid billing configuration");
  });
});

describe("Annual subscription resolution", () => {
  it.each(["price_annual", "price_founder"])(
    "grants Pro only from current Stripe subscription using configured %s",
    async (price) => {
      const now = 1900000000000;
      const raw = Buffer.from(
        JSON.stringify({
          id: "evt_annual",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_annual" } },
        }),
      );
      const sig = `t=${now / 1000},v1=${createHmac("sha256", "whsec_test")
        .update(`${now / 1000}.`)
        .update(raw)
        .digest("hex")}`;
      const fetcher = vi.fn(async () =>
        Response.json({
          id: "sub_annual",
          status: "active",
          metadata: { crot_account_id: "account_1" },
          current_period_end: now / 1000 + 365 * 86400,
          items: { data: [{ price: { id: price } }] },
        }),
      );
      const provider = new StripeBillingProvider({
        secretKey: "sk_test",
        webhookSecret: "whsec_test",
        prices: {
          pro: "price_monthly",
          team: "price_legacy",
          proAnnual: "price_annual",
          proFounderAnnual: "price_founder",
        },
        returnUrl: "https://crot.network/portal",
        now: () => now,
        fetch: fetcher,
      });
      await expect(provider.verifyAndResolve(raw, sig)).resolves.toMatchObject({
        plan: "pro",
        accountId: "account_1",
        expiresAt: now + 365 * 86400000,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const unconfigured = new StripeBillingProvider({
        secretKey: "sk_test",
        webhookSecret: "whsec_test",
        prices: { pro: "price_monthly", team: "price_legacy" },
        returnUrl: "https://crot.network/portal",
        now: () => now,
        fetch: fetcher,
      });
      await expect(unconfigured.verifyAndResolve(raw, sig)).rejects.toThrow("unknown subscription price");
    },
  );
});
