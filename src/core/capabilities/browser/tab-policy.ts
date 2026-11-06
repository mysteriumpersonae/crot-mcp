/** Plain shared policy: extension verifies real tab facts, never trusts an agent's active flag. */
export interface BrowserTabPolicy {
  mode: "active" | "targeted" | "background";
  domains: string[];
  blockedDomains: string[];
  sensitivePreset: boolean;
  /** Targeted mode only: the tab the owner is looking at is in scope too (Desktop: "active tab" + "autonomous"). */
  activeTab?: boolean;
  /** false: no clicks, typing, form, upload or dialog input. Reading and navigation stay available. */
  automation?: boolean;
}
export const SENSITIVE_DOMAIN_PRESET = ["accounts.google.com", "login.microsoftonline.com", "paypal.com", "stripe.com"];
export const DEFAULT_TAB_POLICY: BrowserTabPolicy = {
  mode: "background",
  domains: [],
  blockedDomains: [],
  sensitivePreset: false,
};
/** Extension commands that synthesize owner input; denied while `automation` is false. */
export const AUTOMATION_COMMANDS: readonly string[] = [
  "page.click",
  "page.type",
  "page.hover",
  "page.drag",
  "page.press_key",
  "page.select_option",
  "page.set_checked",
  "files.upload",
  "dialog.handle",
];
/** Extension feature: understands `activeTab` and `automation` in the owner policy. */
export const TAB_POLICY_V2_FEATURE = "tab-policy-v2";
const KEYS = ["mode", "domains", "blockedDomains", "sensitivePreset", "activeTab", "automation"];
export function parseTabPolicy(input: unknown): BrowserTabPolicy {
  if (!input || typeof input !== "object") throw Error("Invalid browser policy");
  const p = input as Record<string, unknown>;
  if (
    Object.keys(p).some((k) => !KEYS.includes(k)) ||
    !["active", "targeted", "background"].includes(String(p.mode)) ||
    typeof p.sensitivePreset !== "boolean" ||
    (p.activeTab !== undefined && typeof p.activeTab !== "boolean") ||
    (p.automation !== undefined && typeof p.automation !== "boolean")
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
  const mode = p.mode as BrowserTabPolicy["mode"];
  return {
    mode,
    domains: domains(p.domains),
    blockedDomains: domains(p.blockedDomains),
    sensitivePreset: p.sensitivePreset,
    // Defaults are omitted, so a default policy keeps the original wire shape.
    ...(mode === "targeted" && p.activeTab === true ? { activeTab: true } : {}),
    ...(p.automation === false ? { automation: false } : {}),
  };
}
/** The policy an extension without TAB_POLICY_V2_FEATURE accepts: never broader than the owner's choice. */
export function legacyTabPolicy(policy: BrowserTabPolicy): BrowserTabPolicy {
  const { mode, domains, blockedDomains, sensitivePreset } = policy;
  return { mode, domains: [...domains], blockedDomains: [...blockedDomains], sensitivePreset };
}
/** True when "active" must mean the active tab of the last focused window, as the owner sees it. */
export function tabPolicyUsesFocusedTab(policy: BrowserTabPolicy): boolean {
  return policy.mode === "active" || (policy.mode === "targeted" && policy.activeTab === true);
}
export function tabPolicyAllowsAutomation(policy: BrowserTabPolicy | undefined, command: string): boolean {
  return policy?.automation !== false || !AUTOMATION_COMMANDS.includes(command);
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
  if (policy.mode === "active") return active;
  if (policy.mode === "targeted") return policy.domains.some(matches) || (policy.activeTab === true && active);
  return true;
}
