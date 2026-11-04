import { AGENTS_CENTER_RENDERER } from "../../src/tray/agents-center-renderer.js";
import { Script } from "node:vm";
import { describe, it, expect } from "vitest";
import { CONTROL_CENTER_RENDERER } from "../../src/tray/control-center-renderer.js";
import { AGENTS_CENTER_CSS } from "../../src/tray/agents-center-style.js";
import { TRAY_ASSETS } from "../../src/tray/assets.js";
import { CrotError } from "../../src/core/errors.js";
import { providerDiagnostic, CHAT_ENDPOINTS } from "../../src/service/chat-runtime.js";
import { UI_MESSAGES_JSON } from "../../src/ui/i18n.js";
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
  it("shows only real connection details and groups sessions without combining grants", () => {
    expect(AGENTS_CENTER_RENDERER).not.toContain("Official integrations");
    expect(AGENTS_CENTER_RENDERER).not.toContain("data-integration");
    expect(AGENTS_CENTER_RENDERER).not.toContain("https://mcp.crot.network");
    expect(CONTROL_CENTER_RENDERER).toContain("Session permissions");
    expect(CONTROL_CENTER_RENDERER).not.toContain("registeredAgents");
    expect(AGENTS_CENTER_CSS).toContain("prefers-reduced-motion");
  });
  it("exposes only allowlisted diagnostics without credentials or provider messages", () => {
    expect(providerDiagnostic(new Error("secret"))).toEqual({ code: "OPERATION_FAILED", stage: "network" });
    expect(
      providerDiagnostic(
        new CrotError("OPERATION_FAILED", "secret", { errno: "ENOTFOUND", url: "secret", stage: "evil" }),
      ),
    ).toEqual({ code: "OPERATION_FAILED", stage: "network", networkCode: "ENOTFOUND" });
    expect(providerDiagnostic(new CrotError("PERMISSION_DENIED", "secret"))).toEqual({
      code: "PERMISSION_DENIED",
      stage: "network",
    });
  });
  it("supports real Gemini/OpenRouter OpenAI-compatible transports", () => {
    expect(CHAT_ENDPOINTS["Google Gemini"]).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(CHAT_ENDPOINTS.OpenRouter).toBe("https://openrouter.ai/api/v1");
  });
});

describe("MCP Server Access remote tunnel toggle", () => {
  it("adds a remote.mode switch and auto-enables it on token generation or URL copy", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
    // English source string, translated at render time (ru: «Удалённый туннель (MCP Relay)»).
    expect(AGENTS_CENTER_RENDERER).toContain("'Remote tunnel (MCP Relay)'");
    expect((JSON.parse(UI_MESSAGES_JSON) as Record<string, string[]>)["Remote tunnel (MCP Relay)"]?.[1]).toBe(
      "Удалённый туннель (MCP Relay)",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("api.action('remote.setMode',{enabled})");
    expect(AGENTS_CENTER_RENDERER).toContain("remoteToggle.input.dataset.remoteMode=''");
    // Every provider card has an explicit Disconnect button that calls chat.remove.
    expect(AGENTS_CENTER_RENDERER).toContain("cloudRemove.dataset.cloudRemove=''");
    expect(AGENTS_CENTER_RENDERER).toContain("localRemove.dataset.localRemove=''");
    expect(AGENTS_CENTER_RENDERER).toContain("wsRemove.dataset.workspaceRemove=''");
    expect(AGENTS_CENTER_RENDERER.match(/button\('Disconnect',/g)?.length).toBeGreaterThanOrEqual(3);
    expect(AGENTS_CENTER_RENDERER).toContain("rpc('chat.remove',{provider:'Local HTTP'})");
    expect(AGENTS_CENTER_RENDERER).toContain("let remoteOn=view.remoteMode===true");
    // Copy URL, silent token generation and Generate / rotate all turn the tunnel on.
    expect(AGENTS_CENTER_RENDERER).toContain("async()=>{ensureRemote();await copy(displayRelayUrl,relayUrlCopy);}");
    expect(AGENTS_CENTER_RENDERER.match(/ensureRemote\(\);\}(?:catch|finally)/g)?.length).toBe(2);
    // The one-time token survives the re-render triggered by remote.mode.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "agentsOneTimeToken={id:r.id,token:r.token};if(!layout.isConnected)return;",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("if(restored){token.input.value=agentsOneTimeToken.token;");
    expect(AGENTS_CENTER_RENDERER).toContain("function ensureRemote(){if(!remoteOn)void setRemote(true);}");
  });
});

describe("Agents provider list, connection note and tunnel status", () => {
  const messages = JSON.parse(UI_MESSAGES_JSON) as Record<string, string[]>;
  const line = (start: string) => AGENTS_CENTER_RENDERER.split("\n").find((l) => l.trim().startsWith(start)) ?? "";

  it("lists provider kinds only; saved custom servers are edited from Connected providers", () => {
    expect(AGENTS_CENTER_RENDERER).toContain(
      "[['OpenAI','OpenAI'],['Anthropic','Anthropic'],['Google Gemini','Google Gemini'],['OpenRouter','OpenRouter'],['OpenCode (Free & Zen)','OpenCode (Free & Zen)'],['Custom API','Custom API (Own server)']]",
    );
    expect(messages["Custom API (Own server)"]?.[1]).toBe("Свой сервер (Custom API)");
    // cloudOptions() only keeps the selection valid; it never adds saved profiles as options.
    const options = line("function cloudOptions(){");
    expect(options).not.toBe("");
    expect(options).not.toMatch(/createElement\('option'\)|node\('option'|\.append\(/);
    // Configure picks the profile: the list shows its kind, the form works on that profile.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "const configure=button('Configure',()=>{pickCloud(c.provider);selectCloud();apiKey.input.focus();}",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("cloudProvider.value=custom?'Custom API':provider;");
    expect(AGENTS_CENTER_RENDERER).toContain("cloudProvider.onchange=()=>{cloudProfile=undefined;selectCloud();};");
  });

  it("asks for the URL and Bearer Token in Custom MCP settings, never OAuth 2.1, and translates the hints", () => {
    const note = "Paste the MCP server URL and the Bearer Token into Custom MCP settings (Notion, Claude, n8n).";
    expect(AGENTS_CENTER_RENDERER).toContain(`t('${note}')`);
    expect(messages[note]?.[1]).toBe(
      "Вставьте URL MCP-сервера и Bearer Token в настройки Custom MCP (Notion, Claude, n8n).",
    );
    expect(AGENTS_CENTER_RENDERER).not.toContain("OAuth 2.1");
    const hint =
      "Enter the base URL of your server. For OpenAI-compatible servers: /v1. Servers without /models support are fine — enter the model name manually.";
    expect(AGENTS_CENTER_RENDERER).toContain(`'${hint}'`);
    expect(messages[hint]?.[1]).toMatch(/^Укажите базовый URL вашего сервера/);
    for (const key of [
      "Remote tunnel is off.",
      "Tunnel connected: remote requests reach this device.",
      "Tunnel not connected; retrying.",
      "Connecting the tunnel…",
      "Checking the tunnel…",
      "Turn on the remote tunnel to check it.",
      "Tunnel check unavailable: the CROT service is not connected.",
      "MCP endpoint is live: requests reach this device through the tunnel.",
      "crot.network does not know this device: registration failed. Check the network and try again.",
      "crot.network is reachable, but the tunnel to this device is not connected yet. Try again in a few seconds.",
      "Cannot reach crot.network. Check the network connection.",
      "Relay responded HTTP",
    ]) {
      expect(AGENTS_CENTER_RENDERER, key).toContain(`'${key}'`);
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
    }
  });

  it("turns the tunnel green only for a ready tunnel or a live check, and checking turns remote mode on", () => {
    expect(AGENTS_CENTER_RENDERER.match(/showTunnel\('connected'/g)).toHaveLength(1);
    expect(AGENTS_CENTER_RENDERER).toContain("else if(s==='ready')showTunnel('connected',");
    expect(AGENTS_CENTER_RENDERER.match(/done\('connected'/g)).toHaveLength(1);
    expect(AGENTS_CENTER_RENDERER).toContain("else if(r.state==='live')done('connected',");
    expect(AGENTS_CENTER_RENDERER).toContain("if(!remoteOn&&!(await setRemote(true)))");
    expect(AGENTS_CENTER_RENDERER).toContain("const r=await window.crot?.checkRelay?.();");
    // The indicator follows the service's tunnel (view updates) and is not wiped by its own text.
    expect(AGENTS_CENTER_RENDERER).toContain("document.addEventListener('crot:view',onTunnelView)");
    expect(CONTROL_CENTER_RENDERER).toContain("document.dispatchEvent(new Event('crot:view'))");
    expect(AGENTS_CENTER_RENDERER).toContain("tunnelStatus.append(tunnelDot)");
    expect(AGENTS_CENTER_RENDERER).not.toContain("text(tunnelStatus,");
  });

  it("opens Agents at the top", () => {
    expect(CONTROL_CENTER_RENDERER).toContain(
      "renderPage();if(name==='Agents'){const main=document.querySelector('main.content');if(main)main.scrollTop=0;}",
    );
  });
});

describe("Other authorization methods and provider checks", () => {
  const messages = JSON.parse(UI_MESSAGES_JSON) as Record<string, string[]>;

  it("shows Basic, API-key and OAuth details of the self-registered URL with copy buttons, translated", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
    // Only for the self-registered crot.network URL (a paired relay URL accepts OAuth Bearer tokens only).
    expect(AGENTS_CENTER_RENDERER).toContain("if(!remoteUrl&&view.localDeviceId){");
    expect(AGENTS_CENTER_RENDERER).toContain("methods.dataset.authMethods=''");
    expect(AGENTS_CENTER_RENDERER).toContain("authRow('Username','crot','basic-username')");
    expect(AGENTS_CENTER_RENDERER).toContain("authRow('Password',undefined,'basic-password')");
    expect(AGENTS_CENTER_RENDERER).toContain("authRow('Header name','X-API-Key','api-key-header')");
    expect(AGENTS_CENTER_RENDERER).toContain("authRow('OAuth Client ID','crot-'+view.localDeviceId,'oauth-client-id')");
    expect(AGENTS_CENTER_RENDERER).toContain("authRow('OAuth Client Secret',undefined,'oauth-client-secret')");
    // Token rows copy the visible token, or generate one exactly as "Copy token" does.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "if(value!==undefined){await copy(value,c);return;}if(token.input.value){await copy(token.input.value,c);return;}tokenCopy.click();",
    );
    expect(AGENTS_CENTER_CSS).toContain(".agents-auth-group h3");
    expect(messages["Other authorization methods (Basic, API Key, OAuth)"]?.[1]).toBe(
      "Другие способы авторизации (Basic, API Key, OAuth)",
    );
    for (const key of [
      "Other authorization methods (Basic, API Key, OAuth)",
      "Use these when the MCP client has no Bearer token option. Every method carries the same token.",
      "Same as the Bearer token",
      "API Key (header)",
      "Header name",
      "Header value",
      "Username",
      "Password",
      "Redirect URL: any https callback of the client. Scope: mcp (or leave empty). The client finds the authorization and token endpoints from the MCP Server URL; approve the request on the crot.network page that opens.",
    ]) {
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
    }
  });

  it("keeps the OpenCode key optional with Save & Test visible, and a check for every provider", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("apiKey.wrap.hidden=false;");
    expect(AGENTS_CENTER_RENDERER).not.toMatch(/apiKey\.wrap\.hidden=(?!false)/);
    expect(AGENTS_CENTER_RENDERER).toContain(
      "text(apiKeyLabel,zen?'API Key (optional for Free / Zen API Key)':'API Key');zenHint.hidden=!zen;",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("zenHint.dataset.zenHint=''");
    // Save & Test sits in the key row, which is never hidden; Local and Workspaces have their own checks.
    expect(AGENTS_CENTER_RENDERER).toContain("keyRow.append(keyInput,saveTest,cloudRemove)");
    expect(AGENTS_CENTER_RENDERER).toContain("saveTest.dataset.cloudTest=''");
    expect(AGENTS_CENTER_RENDERER).toContain(".dataset.localTest=''");
    expect(AGENTS_CENTER_RENDERER).toContain(".dataset.workspaceTest=''");
    // Free models before the first check; Ollama and LM Studio presets.
    expect(AGENTS_CENTER_RENDERER).toContain("config?.suggestedModels||[]");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "[['Ollama','http://127.0.0.1:11434'],['LM Studio','http://127.0.0.1:1234']]",
    );
    for (const key of [
      "API Key (optional for Free / Zen API Key)",
      "Leave empty for free OpenCode Zen models or enter a key from opencode.ai/zen.",
      "Optional: OpenCode Zen API key",
      "OpenCode Zen refused free use without a key (free usage limit). Enter an OpenCode Zen API key in Cloud LLM, or use OpenCode in Workspaces (opencode serve).",
    ]) {
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
    }
  });
});
