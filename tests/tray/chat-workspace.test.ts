import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_RENDERER } from "../../src/tray/control-center-renderer.js";
import { CHAT_CSS } from "../../src/tray/control-center-chat.js";
import { TRAY_ASSETS } from "../../src/tray/assets.js";

describe("scoped Unified Chat workspace", () => {
  const chat = CONTROL_CENTER_RENDERER.split("function chat(root){")[1]!.split("const connectedAccount=")[0]!;
  it("ships a compilable renderer without provider secrets or workspace tab strip in Chat", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
    expect(chat).not.toContain("API key");
    expect(chat).not.toContain("chat.configure");
    expect(chat).not.toContain("pageHead(");
    expect(CONTROL_CENTER_RENDERER).toContain("active!=='Home'&&active!=='Chat'");
    expect(CONTROL_CENTER_RENDERER).toContain("function agents(root){chatProviderSettings(root)");
  });
  it("reads real inventories and keeps tool access opt-in and stop service-backed", () => {
    for (const method of [
      "accounts.list",
      "connectors.list",
      "skills.list",
      "mcpServers.list",
      "chat.providers",
      "chat.models",
      "chat.start",
      "chat.poll",
      "chat.stop",
    ])
      expect(chat).toContain("'" + method + "'");
    expect(chat).toContain("c.enabled&&c.status==='Connected'");
    expect(chat).toContain("a.state==='connected'");
    expect(chat).toContain("tools:[...chatTools]");
    expect(chat).toContain("credentials are never included");
    expect(chat).toContain("message.value+context");
    expect(chat).toContain("chatPast.push(...chatCurrent)");
    expect(chat).toContain("pop.setAttribute('popover','auto')");
  });
  it("loads isolated Chat styles after existing Home styles", () => {
    expect(TRAY_ASSETS["/app.css"]!.body.endsWith(CHAT_CSS)).toBe(true);
    expect(CHAT_CSS).toContain(".chat-active main.content{width:100%;height:100%");
    expect(CHAT_CSS).not.toContain(".home-active");
    expect(CHAT_CSS).not.toContain(".sidebar");
    expect(CHAT_CSS).toContain(".chat-approvals .card .actions");
  });
});
