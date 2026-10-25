/** Public display contract. Stripe price IDs remain operator configuration, never device authority. */
export type ProBillingTerm = "monthly" | "annual" | "founderAnnual";
export interface BillingPrices {
  pro: string;
  team: string;
  proAnnual?: string;
  proFounderAnnual?: string;
}
export const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({ monthlyUsdCents: 0, advertisedProjects: 3 }),
  pro: Object.freeze({
    monthlyUsdCents: 500,
    annualUsdCents: 3900,
    founderAnnualUsdCents: 2900,
    currency: "usd",
    interval: "month",
    trialDays: 7,
  }),
});
export function proPriceContract(term: ProBillingTerm) {
  return term === "monthly"
    ? { amount: PLAN_CATALOG.pro.monthlyUsdCents, interval: "month", key: "pro" as const }
    : term === "annual"
      ? { amount: PLAN_CATALOG.pro.annualUsdCents, interval: "year", key: "proAnnual" as const }
      : { amount: PLAN_CATALOG.pro.founderAnnualUsdCents, interval: "year", key: "proFounderAnnual" as const };
}
