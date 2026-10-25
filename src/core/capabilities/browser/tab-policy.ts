/** Plain shared policy: extension verifies real tab facts, never trusts an agent's active flag. */
export interface BrowserTabPolicy {
  mode: "active" | "targeted" | "background";
  domains: string[];
  blockedDomains: string[];
  sensitivePreset: boolean;
}
export const SENSITIVE_DOMAIN_PRESET = ["accounts.google.com", "login.microsoftonline.com", "paypal.com", "stripe.com"];
export const DEFAULT_TAB_POLICY: BrowserTabPolicy = {
  mode: "background",
  domains: [],
  blockedDomains: [],
  sensitivePreset: false,
};
export function parseTabPolicy(input: unknown): BrowserTabPolicy {
  if (!input || typeof input !== "object") throw Error("Invalid browser policy");
  const p = input as Record<string, unknown>;
  if (
    Object.keys(p).some((k) => !["mode", "domains", "blockedDomains", "sensitivePreset"].includes(k)) ||
    !["active", "targeted", "background"].includes(String(p.mode)) ||
    typeof p.sensitivePreset !== "boolean"
  )
    throw Error("Invalid browser policy");
  const domains = (v: unknown) => {
    if (
      !Array.isArray(v) ||
      v.length > 128 ||
      !v.every(
        (d) =>
          typeof d === "string" &&
          d.length <= 253 &&
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(d),
      )
    )
      throw Error("Use hostnames without URL, wildcard or path");
    return [...new Set(v.map((d) => String(d).toLowerCase()))];
  };
  return {
    mode: p.mode as BrowserTabPolicy["mode"],
    domains: domains(p.domains),
    blockedDomains: domains(p.blockedDomains),
    sensitivePreset: p.sensitivePreset,
  };
}
export function tabPolicyAllows(policy: BrowserTabPolicy, url: string, active: boolean): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  const matches = (d: string) => host === d || host.endsWith("." + d);
  if ([...policy.blockedDomains, ...(policy.sensitivePreset ? SENSITIVE_DOMAIN_PRESET : [])].some(matches))
    return false;
  return policy.mode === "active" ? active : policy.mode === "targeted" ? policy.domains.some(matches) : true;
}
