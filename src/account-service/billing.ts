/** Hosted billing only; validates the provider's raw-byte signature before parsing. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingUpdate, Plan, SubscriptionStatus } from "./service.js";
export interface BillingProvider {
  verify(raw: Buffer, signature: string | undefined): BillingUpdate | undefined;
  checkout(accountId: string, plan: "pro" | "team"): Promise<string>;
}
export class BillingError extends Error {
  constructor() {
    super("invalid_billing_event");
  }
}
interface StripeSubscription {
  id: string;
  status: string;
  metadata: { accountId?: string };
  current_period_end?: number;
  items: { data: { current_period_end?: number; price: { id: string } }[] };
}
export interface StripeOptions {
  webhookSecret: string;
  /** Trusted server-side prices; the webhook never gets to set arbitrary device limits. */
  prices: { pro: string; team: string };
  apiKey?: string;
  /** Fixed owner-configured HTTPS URL, never from an API request. */
  returnUrl: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}
export class StripeBillingProvider implements BillingProvider {
  constructor(private readonly options: StripeOptions) {
    const url = new URL(options.returnUrl);
    if (
      !options.webhookSecret ||
      options.prices.pro === options.prices.team ||
      !options.prices.pro ||
      !options.prices.team ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    )
      throw new Error("invalid billing configuration");
  }
  verify(raw: Buffer, signature: string | undefined): BillingUpdate | undefined {
    if (!signature || signature.length > 4096 || raw.length > 256 * 1024) throw new BillingError();
    const parts = signature.split(",");
    const timestamps = parts.filter((p) => p.startsWith("t="));
    if (timestamps.length !== 1 || !/^t=\d+$/.test(timestamps[0]!)) throw new BillingError();
    const time = Number(timestamps[0]!.slice(2));
    if (!Number.isSafeInteger(time) || Math.abs((this.options.now ?? Date.now)() / 1000 - time) > 300)
      throw new BillingError();
    const expected = createHmac("sha256", this.options.webhookSecret)
      .update(String(time) + ".")
      .update(raw)
      .digest();
    if (!parts.some((p) => /^v1=[a-f0-9]{64}$/.test(p) && timingSafeEqual(expected, Buffer.from(p.slice(3), "hex"))))
      throw new BillingError();
    try {
      const event = JSON.parse(raw.toString("utf8")) as {
        id: string;
        created: number;
        type: string;
        data: { object: StripeSubscription };
      };
      if (
        !["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(
          event.type,
        )
      )
        return undefined;
      const s = event.data.object;
      if (
        !s ||
        !s.items ||
        s.items.data.length !== 1 ||
        typeof s.metadata?.accountId !== "string" ||
        !Number.isSafeInteger(event.created) ||
        event.created < 0 ||
        event.created > time + 60
      )
        throw new BillingError();
      const price = s.items.data[0]!;
      const plan: Plan =
        price.price.id === this.options.prices.pro
          ? "pro"
          : price.price.id === this.options.prices.team
            ? "team"
            : "free";
      if (plan === "free") throw new BillingError();
      const status: SubscriptionStatus =
        event.type === "customer.subscription.deleted" || s.status === "canceled"
          ? "canceled"
          : s.status === "active"
            ? "active"
            : ["past_due", "unpaid", "incomplete", "paused"].includes(s.status)
              ? "past_due"
              : "expired";
      const expires = s.current_period_end ?? price.current_period_end;
      if (!Number.isSafeInteger(expires) || expires! <= 0) throw new BillingError();
      return {
        accountId: s.metadata.accountId,
        subscriptionId: s.id,
        eventId: event.id,
        plan,
        status,
        expiresAt: expires! * 1000,
        updatedAt: event.created * 1000,
      };
    } catch {
      throw new BillingError();
    }
  }
  async checkout(accountId: string, plan: "pro" | "team"): Promise<string> {
    if (!this.options.apiKey) throw new Error("billing_unavailable");
    const form = new URLSearchParams({
      mode: "subscription",
      client_reference_id: accountId,
      "subscription_data[metadata][accountId]": accountId,
      "line_items[0][price]": this.options.prices[plan],
      "line_items[0][quantity]": "1",
      success_url: this.options.returnUrl,
      cancel_url: this.options.returnUrl,
    });
    const response = await (this.options.fetch ?? fetch)("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("billing_unavailable");
    }
    const body = (await response.json()) as { url?: string };
    if (typeof body.url !== "string" || new URL(body.url).origin !== "https://checkout.stripe.com")
      throw new Error("billing_unavailable");
    return body.url;
  }
}
