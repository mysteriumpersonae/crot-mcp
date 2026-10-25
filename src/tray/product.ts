import { CONNECTOR_MANIFESTS } from "../service/connector-manifests.js";
/** Product information architecture. Labels are canonical offline translation keys. */
export const SECTIONS = [
  "Home",
  "Chat",
  "Accounts",
  "Permissions",
  "Projects",
  "Agents",
  "Connectors",
  "MCP Servers",
  "Browser",
  "Files",
  "Terminal",
  "Git",
  "Docker",
  "Tasks",
  "Monitoring",
  "Settings",
] as const;
export const PROJECT_TABS = ["Overview", "Files", "Git", "Tasks", "Agents", "Connectors", "Settings"] as const;
export const SETTINGS = [
  "General",
  "Device & Account",
  "Subscription",
  "Remote Access",
  "Security",
  "Permissions",
  "Browser",
  "Network",
  "Integrations",
  "MCP",
  "Updates & Diagnostics",
  "About",
] as const;
export const CONNECTORS = CONNECTOR_MANIFESTS.map((m) => [m.id, m.category, m.kind] as const);

/** Ten owner-requested destinations. Existing guarded tools remain contextual. */
export const PRIMARY_SECTIONS = [
  "Home",
  "Chat",
  "Agents",
  "Projects",
  "Connectors",
  "Accounts",
  "Permissions",
  "Browser",
  "Monitoring",
  "Settings",
] as const;
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  Chat: "Unified Chat",
  Agents: "Agents & Tokens",
  Monitoring: "Journal",
};
