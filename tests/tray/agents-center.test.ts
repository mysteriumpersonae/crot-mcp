import { AGENTS_CENTER_RENDERER } from "../../src/tray/agents-center-renderer.js";
import { Script } from "node:vm";
import { describe, it, expect } from "vitest";
import { CONTROL_CENTER_RENDERER } from "../../src/tray/control-center-renderer.js";
import { AGENTS_CENTER_CSS } from "../../src/tray/agents-center-style.js";
import { TRAY_ASSETS } from "../../src/tray/assets.js";
import { CHAT_ENDPOINTS } from "../../src/service/chat-runtime.js";
describe("scoped Agents center", () => {
  it("compiles and removes only Agents workspace tab strip", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
    expect(CONTROL_CENTER_RENDERER).toContain("active!=='Home'&&active!=='Chat'&&active!=='Agents'");
    expect(AGENTS_CENTER_CSS).toContain("grid-template-columns:1fr 1fr;gap:24px");
    expect(AGENTS_CENTER_CSS).not.toContain(".sidebar");
    expect(TRAY_ASSETS["/app.css"]!.body).toContain(AGENTS_CENTER_CSS);
  });
  it("keeps relay canonical, tokens one-time, audit-backed mutations and OAuth workspaces", () => {
    for (const name of [
      "tokens.list",
      "tokens.issue",
      "tokens.rotate",
      "chat.configure",
      "chat.testConnection",
      "accounts.list",
      "accounts.configure",
      "accounts.connect",
      "accounts.disconnect",
    ])
      expect(CONTROL_CENTER_RENDERER).toContain("'" + name + "'");
    expect(CONTROL_CENTER_RENDERER).toContain("This scoped Bearer token is for local HTTP MCP only");
    expect(CONTROL_CENTER_RENDERER).toContain("view.resourceUri");
    expect(CONTROL_CENTER_RENDERER).not.toContain("mcp.crot.ai");
    expect(CONTROL_CENTER_RENDERER).toContain("navigator.clipboard.writeText(value)");
  });
  it("contains only callable workspace agent providers, not data-account OAuth", () => {
    expect(AGENTS_CENTER_RENDERER).not.toContain("accounts.list");
    expect(AGENTS_CENTER_RENDERER).not.toContain("accounts.connect");
    expect(AGENTS_CENTER_RENDERER).not.toContain("GitHub");
    expect(AGENTS_CENTER_RENDERER).toContain("['OpenCode','Notion Agents']");
    expect(AGENTS_CENTER_RENDERER).toContain("chat.remove");
    expect(AGENTS_CENTER_RENDERER).toContain("fitAccordions");
    expect(AGENTS_CENTER_RENDERER).toContain("pop.setAttribute('popover','auto')");
    expect(AGENTS_CENTER_CSS).toContain("overflow-y:auto");
    expect(CONTROL_CENTER_RENDERER).toContain("next.resourceUri,next.localMcpUrl,next.pairing");
  });
  it("supports real Gemini/OpenRouter OpenAI-compatible transports", () => {
    expect(CHAT_ENDPOINTS["Google Gemini"]).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(CHAT_ENDPOINTS.OpenRouter).toBe("https://openrouter.ai/api/v1");
  });
});
