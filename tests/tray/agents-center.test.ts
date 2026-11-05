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
      "OpenCode Zen refused free use without a key (free usage limit). Enter an OpenCode Zen API key, or connect through local OpenCode (Auto-connect).",
    ]) {
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
    }
  });

  it("offers a Zen key link, auto-connect through local OpenCode, the install command and a managed server", () => {
    // Cloud LLM: the key page opens in the browser; Auto-connect is the same check as Save & Test (a typed,
    // stored or OpenCode-found key goes to the Zen API, no key to local OpenCode).
    expect(AGENTS_CENTER_RENDERER).toContain(
      "const zenKeyLink=externalLink('Get a Zen key ↗','https://opencode.ai/zen','agents-light-button agents-link-button');",
    );
    expect(AGENTS_CENTER_RENDERER).toContain(
      "const zenAuto=button('Auto-connect via local OpenCode',()=>saveAndTest(),'agents-light-button');",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("const saveTest=button('Save & Test',saveAndTest,'primary');");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "await checkProvider(provider,cloudEndpoint.input.value||(baseOf(provider)==='OpenCode (Free & Zen)'?defaults['OpenCode (Free & Zen)']:''),key,cloudState,checked,cloudModel,extra);",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("a.setAttribute('rel','noopener noreferrer')");
    expect(AGENTS_CENTER_RENDERER).toContain("zenAuto.dataset.opencodeAuto=''");
    expect(AGENTS_CENTER_RENDERER).toContain("copyInstall.dataset.copyInstall=''");
    expect(AGENTS_CENTER_RENDERER).toContain("openCodeInfo=await rpc('opencode.status')");
    // Workspaces: CROT's own server after a warning, its status and Stop.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "await checkProvider('OpenCode','http://127.0.0.1:4096','',workspaceState,workspaceChecked,workspaceModel,{managed:true});",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("wsStart.dataset.opencodeStart=''");
    expect(AGENTS_CENTER_RENDERER).toContain("await rpc('opencode.stop')");
    expect(AGENTS_CENTER_RENDERER).toContain("t('Running on')+' '+server.url.replace('http://','')");
    for (const [key, ru] of [
      ["Get a Zen key ↗", "Получить ключ Zen ↗"],
      ["Auto-connect via local OpenCode", "Авто-подключение через локальный OpenCode"],
      ["Get a free or paid API key at opencode.ai/zen ↗", "Получить бесплатный/платный API-ключ на opencode.ai/zen ↗"],
      ["Start and connect OpenCode", "Запустить и подключить OpenCode"],
      ["Running on", "Запущен на"],
    ] as [string, string][])
      expect(messages[key]?.[1], key).toBe(ru);
    for (const key of [
      "Or install OpenCode CLI (npm i -g opencode-ai) so CROT starts the local bridge to the free models automatically.",
      "Install OpenCode CLI (npm i -g opencode-ai) so CROT can start it.",
      "Through local OpenCode",
      "Key from OpenCode (auth.json)",
      "Key from OPENCODE_API_KEY",
      "started by CROT",
      "already running",
      "started outside CROT",
      "CROT starts opencode serve on 127.0.0.1 with a random password and connects to it. OpenCode agents act in the open project with their own permissions (files, commands); CROT tool grants are not forwarded and CROT never auto-approves their actions.",
      "OpenCode's free usage limit is reached (OpenCode suggests its Go subscription). Try again later, or enter an OpenCode Zen API key.",
      "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key.",
      "Local OpenCode refused the request.",
      "Local OpenCode could not be started. Install the verified OpenCode into CROT with one click (your own OpenCode stays as it is), or enter an OpenCode Zen API key.",
      "Your OpenCode is too old for CROT (version 1.0 or newer is needed). Install the verified OpenCode into CROT with one click, or update yours with “opencode upgrade”.",
      "Starting local OpenCode is blocked by the emergency stop or the runtime policy.",
      // Chat errors of the local bridge (chat-runtime.ts), translated where the chat shows them.
      "Local OpenCode takes text only: images are not forwarded. Remove them or enter an OpenCode Zen API key.",
      "Through local OpenCode the model can only read the open project (list, read and search files); other CROT tools are not forwarded. Turn them off or enter an OpenCode Zen API key.",
      "Installing OpenCode…",
      "CROT downloads the verified OpenCode (about 80 MB) from the npm registry into its own folder and starts it. No terminal, Node.js or npm needed.",
      "Install verified OpenCode into CROT (1 click)",
      "Reinstall OpenCode in CROT (1 click)",
      "Your own OpenCode stays as it is: CROT keeps its copy with its own settings and data.",
      "copy installed by CROT",
      "Installing OpenCode is blocked by the emergency stop or the runtime policy.",
      "OpenCode could not be downloaded from registry.npmjs.org. Check the network or proxy and try again.",
      "The downloaded OpenCode did not match its published checksum and was removed. Try again.",
      "OpenCode could not be installed. Check the network, proxy and free disk space, then try again.",
      "No OpenCode build for this system runs here. Install OpenCode with the command below.",
      "The installation was stopped.",
      "CROT downloads the verified OpenCode into its own folder, then starts opencode serve on 127.0.0.1 with a random password and connects to it. OpenCode agents act in the open project with their own permissions (files, commands); CROT tool grants are not forwarded and CROT never auto-approves their actions.",
    ]) {
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
      expect(
        AGENTS_CENTER_RENDERER.includes(key.replace("'", "\\'")) ||
          key.startsWith("Local OpenCode takes") ||
          key.startsWith("Through local OpenCode the model"),
        key,
      ).toBe(true);
    }
  });

  it("shows the exact reason of a failed check (code, HTTP status, model, OpenCode's words), never a generic one", () => {
    expect(AGENTS_CENTER_RENDERER).not.toContain("Connection failed. Check server, key and network.");
    expect(messages["Connection failed. Check server, key and network."]).toBeUndefined();
    const source = /function diagnosticText\(d,lead\)\{[^\n]*\}\n/.exec(AGENTS_CENTER_RENDERER)?.[0];
    expect(source).toBeDefined();
    const diagnosticText = new Function("t", `${source}return diagnosticText;`)((value: string) => value) as (
      d: Record<string, unknown>,
      lead?: string,
    ) => string;
    // The tray's own answers (product-failure.ts): a slow service, a closed connection, a refused request.
    expect(diagnosticText({ code: "SERVICE_TIMEOUT", stage: "service" })).toBe(
      "The CROT service did not answer in time. Try again: the first start of local OpenCode can take up to a minute. [SERVICE_TIMEOUT]",
    );
    expect(diagnosticText({ code: "SERVICE_UNAVAILABLE", stage: "service" })).toContain("not connected");
    expect(
      diagnosticText(
        { code: "REQUEST_REFUSED", stage: "service", detail: "Workspace agent request failed" },
        "The model list could not be loaded.",
      ),
    ).toBe("The model list could not be loaded. [REQUEST_REFUSED] — Workspace agent request failed");
    // OpenCode missing: exactly what to click, without a technical tag; OpenCode's refusal: its status, the model and its own words.
    expect(diagnosticText({ code: "OPENCODE_NOT_INSTALLED", stage: "local" })).toBe(
      "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key.",
    );
    // OpenCode that does not start: what to do, then exactly why (the program, its exit code and last error line).
    expect(
      diagnosticText({
        code: "OPENCODE_START_FAILED",
        stage: "local",
        detail: "~/.npm-global/bin/opencode: exited with code 1 — Error: opencode-ai's postinstall script was not run.",
      }),
    ).toBe(
      "Local OpenCode could not be started. Install the verified OpenCode into CROT with one click (your own OpenCode stays as it is), or enter an OpenCode Zen API key. [OPENCODE_START_FAILED] — ~/.npm-global/bin/opencode: exited with code 1 — Error: opencode-ai's postinstall script was not run.",
    );
    expect(
      diagnosticText({
        code: "OPENCODE_TOO_OLD",
        stage: "local",
        detail: "~/.opencode/bin/opencode 0.15.31: CROT needs OpenCode 1.0.0 or newer",
      }),
    ).toBe(
      "Your OpenCode is too old for CROT (version 1.0 or newer is needed). Install the verified OpenCode into CROT with one click, or update yours with “opencode upgrade”. [OPENCODE_TOO_OLD] — ~/.opencode/bin/opencode 0.15.31: CROT needs OpenCode 1.0.0 or newer",
    );
    expect(
      diagnosticText({
        code: "OPERATION_FAILED",
        stage: "local",
        httpStatus: 500,
        model: "glm-5.3-flash-free",
        detail: "UnknownError: Unexpected server error. Check server logs for details. (ref err_1)",
      }),
    ).toBe(
      "Local OpenCode refused the request. [OPERATION_FAILED · HTTP 500 · glm-5.3-flash-free] — UnknownError: Unexpected server error. Check server logs for details. (ref err_1)",
    );
    expect(
      diagnosticText({
        code: "FREE_TIER_LIMIT",
        stage: "local",
        httpStatus: 429,
        model: "big-pickle",
        detail: "Free usage exceeded, subscribe to Go (https://opencode.ai/go)",
      }),
    ).toContain("[FREE_TIER_LIMIT · HTTP 429 · big-pickle] — Free usage exceeded");
    // Green "Connected" once OpenCode is up and lists its models; a refused test request is a warning beside it.
    expect(AGENTS_CENTER_RENDERER).toContain("baseOf(provider.provider)==='OpenCode (Free & Zen)'?'Connected'");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "cloud.append(endpointSection,modelRow,cloudStatus,zenCheck,zenRoute,zenInstall);",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("c.modelCheck?.ok===false&&c.modelCheck.model===c.defaultModel");
    expect(AGENTS_CENTER_RENDERER).toContain("keySource:r.keySource,modelCheck:r.modelCheck}");
    // A failure without a diagnostic keeps its own message; none falls back to a generic text.
    expect(AGENTS_CENTER_RENDERER).toContain("connectionMessage:error.message");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "(provider.connectionMessage||'The last check failed without details. Check again.')",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("connectionMessage:'The model list could not be loaded.'");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "connectionMessage:'Providers could not be loaded from the CROT service.'",
    );
    expect(
      messages[
        "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key."
      ]?.[1],
    ).toBe(
      "Локальный OpenCode CLI не найден. Нажмите «Установить и запустить OpenCode (1 клик)» или введите API-ключ Zen.",
    );
    expect(messages["Connected"]?.[1]).toBe("Подключено");
    for (const key of [
      "The CROT service did not answer in time. Try again: the first start of local OpenCode can take up to a minute.",
      "The CROT service is not connected. Restart CROT and try again.",
      "The CROT service refused the request.",
      "Local OpenCode refused the request.",
      "The last check failed without details. Check again.",
      "The model list could not be loaded.",
      "Providers could not be loaded from the CROT service.",
      "Connected, but OpenCode refused a test request with this model.",
      "Choose another free model or try again later.",
    ]) {
      expect(messages[key]?.length, key).toBe(5);
      expect(messages[key]![1], key).not.toBe(key);
      expect(AGENTS_CENTER_RENDERER, key).toContain(key);
    }
  });

  it("installs and starts OpenCode in one click on the Zen card and in Workspaces", () => {
    // The service installs in the background (opencode.install); the UI follows the status, then connects.
    expect(AGENTS_CENTER_RENDERER).toContain("openCodeInfo=await rpc('opencode.install')");
    expect(AGENTS_CENTER_RENDERER).toContain("run.dataset.opencodeInstallRun=''");
    expect(AGENTS_CENTER_RENDERER).toContain("while(openCodeInfo?.runtime?.state==='installing'&&layout.isConnected)");
    // Offered whenever OpenCode is missing or did not start (no Node.js or npm needed), with the download's progress.
    expect(AGENTS_CENTER_RENDERER).toContain("if(info.installable||installing)");
    expect(AGENTS_CENTER_RENDERER).not.toContain("One-click install needs npm");
    expect(AGENTS_CENTER_RENDERER).not.toContain("npm_not_found");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "t('Installing OpenCode…')+(Number.isInteger(runtime.progress)?' '+runtime.progress+' %':'')",
    );
    expect(AGENTS_CENTER_RENDERER).toContain("const missing=zen&&!ok&&needsInstall(openCodeInfo);");
    expect(AGENTS_CENTER_RENDERER).toContain(
      "installHint(wsInstall,opencode&&!server&&needsInstall(openCodeInfo)?openCodeInfo:undefined,",
    );
    const source = /function needsInstall\(info\)\{[^\n]*\}\n/.exec(AGENTS_CENTER_RENDERER)?.[0];
    expect(source).toBeDefined();
    const needsInstall = new Function(`${source}return needsInstall;`)() as (info: unknown) => boolean;
    const owner = { code: "OPENCODE_START_FAILED", source: "owner" },
      crot = { code: "OPENCODE_START_FAILED", source: "crot" };
    expect(needsInstall(undefined)).toBe(false);
    expect(needsInstall({ installed: false })).toBe(true);
    expect(needsInstall({ installed: true })).toBe(false);
    // The owner's OpenCode did not start: CROT's copy helps unless it is installed already (then it is tried next).
    expect(needsInstall({ installed: true, problem: owner, runtime: { state: "missing" } })).toBe(true);
    expect(needsInstall({ installed: true, problem: owner, runtime: { state: "failed" } })).toBe(true);
    expect(needsInstall({ installed: true, problem: owner, runtime: { state: "installed" } })).toBe(false);
    // CROT's own copy did not start: reinstall it.
    expect(needsInstall({ installed: true, problem: crot, runtime: { state: "installed" } })).toBe(true);
    expect(AGENTS_CENTER_RENDERER).toContain(
      "label=!problem?'Install and start OpenCode (1 click)':runtime.state==='installed'?'Reinstall OpenCode in CROT (1 click)':'Install verified OpenCode into CROT (1 click)'",
    );
    for (const [reason, text] of [
      ["download_failed", "OpenCode could not be downloaded from registry.npmjs.org."],
      ["integrity_mismatch", "did not match its published checksum"],
      ["install_failed", "OpenCode could not be installed."],
      ["binary_not_found", "No OpenCode build for this system runs here."],
    ] as [string, string][])
      expect(AGENTS_CENTER_RENDERER).toMatch(new RegExp(`${reason}:'[^']*${text.replace(/[.]/g, "\\.")}`));
    expect(AGENTS_CENTER_RENDERER).toContain("(runtime.detail?' — '+runtime.detail:'')");
    // Zen: the same Save & Test as Auto-connect; Workspaces: the managed server, after the owner confirms.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "installHint(zenInstall,missing?openCodeInfo:undefined,true,()=>checkProvider('OpenCode (Free & Zen)',cloudEndpoint.input.value||defaults['OpenCode (Free & Zen)'],'',cloudState,checked,cloudModel));",
    );
    expect(AGENTS_CENTER_RENDERER).toContain(
      "false,()=>checkProvider('OpenCode','http://127.0.0.1:4096','',workspaceState,workspaceChecked,workspaceModel,{managed:true}),'CROT downloads the verified OpenCode into its own folder",
    );
    expect(AGENTS_CENTER_RENDERER).toContain(
      "warning?confirm(label,()=>installOpenCode(connect),warning):installOpenCode(connect)",
    );
    // The route names CROT's copy when it serves.
    expect(AGENTS_CENTER_RENDERER).toContain(
      "t(server.managed?(server.source==='crot'?'copy installed by CROT':'started by CROT'):'already running')",
    );
    for (const [key, ru] of [
      ["Install and start OpenCode (1 click)", "Установить и запустить OpenCode (1 клик)"],
      ["Install verified OpenCode into CROT (1 click)", "Установить проверенный OpenCode в CROT (1 клик)"],
      ["Reinstall OpenCode in CROT (1 click)", "Переустановить OpenCode в CROT (1 клик)"],
      [
        "CROT downloads the verified OpenCode (about 80 MB) from the npm registry into its own folder and starts it. No terminal, Node.js or npm needed.",
        "CROT скачает проверенный OpenCode (около 80 МБ) из реестра npm в свою папку и запустит его. Терминал, Node.js и npm не нужны.",
      ],
      [
        "Local OpenCode could not be started. Install the verified OpenCode into CROT with one click (your own OpenCode stays as it is), or enter an OpenCode Zen API key.",
        "Не удалось запустить локальный OpenCode. Установите проверенный OpenCode в CROT одним кликом (ваш OpenCode останется как есть) или введите API-ключ Zen.",
      ],
    ] as [string, string][])
      expect(messages[key]?.[1], key).toBe(ru);
  });
});
