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
    expect(CONTROL_CENTER_RENDERER).toContain("function agents(root){");
    expect(CONTROL_CENTER_RENDERER).toContain("agents-center");
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
    expect(chat).toContain("id:'account:'+a.provider+':'+(a.id||a.generation)");
    expect(chat).toContain("tools:[...chatTools]");
    expect(chat).toContain("credentials are never included");
    expect(chat).toContain("message.value+context");
    expect(chat).toContain("chatPast.push(...chatCurrent)");
    expect(chat).toContain("pop.setAttribute('popover','auto')");
  });
  it("separates platform, skill and agent roles without unrelated footer logos", () => {
    expect(chat).toContain("menu('Connected Platforms','web')");
    expect(chat).toContain("menu('Skills','skills')");
    expect(chat).toContain("footer(skill.pop,'Connectors','Add skill',skillItems,'skills')");
    expect(chat).toContain("document.querySelector('[data-create-skill]')?.click()");
    expect(chat).toContain("items.slice(0,3)");
    expect(chat).not.toContain("['GitHub','Notion','YouTube']");
    expect(chat).not.toContain("data-agent-id");
    expect(chat).not.toContain("agents.list");
    expect(chat).toContain("Inbound MCP client sessions are not callable outbound chat providers");
    expect(chat).toContain("inventoryLoaded&&chatWeb");
    expect(chat).toContain("inventoryLoaded&&chatSkill");
  });
  it("uses a subtle outer composer focus and a circular send button", () => {
    expect(CHAT_CSS).toContain(".chat-compose:focus-within{border-color:#aeb6c2;box-shadow:none}");
    expect(CHAT_CSS).toContain("outline:none;outline-offset:0;box-shadow:none;border:0");
    expect(CHAT_CSS).toContain("width:44px;height:44px;min-width:44px;min-height:44px");
    expect(TRAY_ASSETS["/app.css"]!.body).toContain(
      "#notification-count{display:grid;place-items:center;width:20px;height:20px",
    );
  });
  it("loads isolated Chat styles after existing Home styles", () => {
    expect(TRAY_ASSETS["/app.css"]!.body.endsWith(CHAT_CSS)).toBe(true);
    expect(CHAT_CSS).toContain(".chat-active main.content{width:100%;height:100%");
    expect(CHAT_CSS).not.toContain(".home-active");
    expect(CHAT_CSS).not.toContain(".sidebar");
    expect(CHAT_CSS).toContain(".chat-approvals .card .actions");
  });
});
