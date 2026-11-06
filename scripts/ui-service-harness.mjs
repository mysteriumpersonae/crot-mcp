import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
/** Test-only HTTP replacement for Electron IPC. All data/actions use an isolated real CrotService. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { ControlClient } from "../dist/service/control-client.js";
import { TrayToolClient } from "../dist/tray/tool-client.js";
import { TrayController } from "../dist/tray/controller.js";
import { productFailure } from "../dist/tray/product-failure.js";
import { trayView } from "../dist/tray/view-model.js";
import { createPrivateFileProtection } from "../dist/core/platform/private-files.js";
export async function serviceHarness() {
  const base = await mkdtemp(path.join(tmpdir(), "crot-ui-service-")),
    workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const extensionDir = path.join(base, "extension");
  await mkdir(extensionDir);
  await writeFile(path.join(extensionDir, "manifest.json"), await readFile(path.resolve("extension/manifest.json")));
  const env = {
    ...process.env,
    HOME: base,
    LOCALAPPDATA: path.join(base, "local"),
    APPDATA: path.join(base, "roaming"),
    XDG_STATE_HOME: path.join(base, "state"),
    XDG_CONFIG_HOME: path.join(base, "config"),
    // The UI turns the remote tunnel on (Copy URL, tokens): keep the self-registered tunnel off the public relay.
    CROT_SELF_RELAY_HOST: "relay.invalid",
    // Browser auto-discovery on a free port (never the owner's 43115-43119); no browser manifests or registry keys.
    CROT_BROWSER_LOOPBACK_PORTS: "0",
    CROT_BROWSER_AUTO_REGISTER: "off",
    CROT_BROWSER_EXTENSION_DIR: extensionDir,
  };
  const stateDir =
    process.platform === "win32"
      ? path.join(env.LOCALAPPDATA, "CROT")
      : process.platform === "darwin"
        ? path.join(base, "Library", "Application Support", "CROT", "State")
        : path.join(base, "state", "crot");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, "secrets.json"), JSON.stringify({ version: 1, backend: "file" }), {
    mode: 0o600,
  });
  const bin = path.resolve("dist/bin/crot-mcp.js"),
    config = path.join(base, "config.json");
  let tool, control, controller, view, endpoint, inspectionGate, releaseInspection, extension;
  let inspectionCalls = 0;
  return {
    base,
    workspace,
    bin,
    stateDir,
    async start(origin) {
      endpoint = origin + "/provider-probe";
      await writeFile(
        config,
        JSON.stringify({
          workspace: { root: workspace },
          permissions: {
            mode: "full_control",
            approvals: { untrustedContent: "off" },
            network: { allow: [new URL(origin).host] },
          },
          audit: { sink: "file", path: path.join(base, "audit.jsonl") },
        }),
      );
      tool = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env });
      await tool.call("fs_list_directory", { path: "." });
      control = await ControlClient.connect({
        stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
      });
      if (!control) throw Error("Service control channel unavailable");
      controller = new TrayController({
        stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
        onUpdate: (s) => {
          view = trayView(s);
        },
      });
      await controller.start();
    },
    pauseProjectInspection() {
      inspectionGate = new Promise((resolve) => {
        releaseInspection = resolve;
      });
    },
    releaseProjectInspection() {
      releaseInspection?.();
      inspectionGate = undefined;
    },
    get inspectionCalls() {
      return inspectionCalls;
    },
    async configureChatApproval() {
      await control.request("security.setPolicy", {
        strict: false,
        rules: [{ operation: "filesystem.write_file", state: "ask" }],
        projectGrants: [],
      });
    },
    async verifyChat() {
      const content = await readFile(path.join(base, "second", "chat-proof.txt"), "utf8");
      if (content !== "real-chat-approved") throw Error("Chat tool did not write the approved file");
      const journal = (await readFile(path.join(base, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (
        !journal.some(
          (event) =>
            event.operation === "filesystem.write_file" &&
            event.outcome === "success" &&
            event.approval?.status === "approved",
        )
      )
        throw Error("Approved chat audit missing");
      const { agents } = await control.request("agents.list");
      if (!agents.some((agent) => agent.name === "Local HTTP chat")) throw Error("Chat agent identity missing");
      return { approvedChatWrite: true, registeredChatAgent: true };
    },
    async handle(req, res, pathname) {
      if (pathname === "/mcp-fixture") {
        const server = new McpServer({ name: "ui-http-fixture", version: "1" });
        server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
          content: [{ type: "text", text }],
        }));
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return true;
      }
      if (pathname.startsWith("/native-opencode") || pathname.startsWith("/native-notion")) {
        const opencode = pathname.startsWith("/native-opencode"),
          base = opencode ? "/native-opencode" : "/native-notion/v1",
          route = pathname.slice(base.length);
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        const expected = opencode
          ? "Basic " + Buffer.from("opencode:fixture-opencode-password").toString("base64")
          : "Bearer fixture-notion-agents-key";
        if (req.headers.authorization !== expected || (!opencode && req.headers["notion-version"] !== "2026-03-11")) {
          res.writeHead(401).end("{}");
          return true;
        }
        let value;
        if (opencode && route === "/global/health") value = { healthy: true, version: "fixture" };
        else if (opencode && route === "/provider")
          value = {
            connected: ["fixture"],
            all: [
              { id: "fixture", models: { "native-model": { name: "OpenCode native model" } } },
              { id: "disconnected", models: { "do-not-list": {} } },
            ],
          };
        else if (opencode && route === "/session" && req.method === "POST") value = { id: "session-fixture" };
        else if (
          opencode &&
          route === "/session/session-fixture/message" &&
          body.parts?.[0]?.text &&
          body.model?.modelID === "native-model"
        )
          value = { info: {}, parts: [{ type: "text", text: "OpenCode native fixture answer" }] };
        else if (!opencode && route === "/agents/query")
          value = {
            results: [
              { id: "agent-fixture", agent_type: "custom_agent", status: "active", name: "Notion native agent" },
              { id: "inactive", agent_type: "custom_agent", status: "paused", name: "Do not list" },
            ],
            has_more: false,
          };
        else if (!opencode && route === "/sessions" && body.agent_id === "agent-fixture" && body.message)
          value = { id: "notion-session", status: "queued" };
        else if (!opencode && route === "/sessions/notion-session")
          value = { id: "notion-session", status: "completed" };
        else if (!opencode && route === "/sessions/notion-session/events/query")
          value = {
            results: [{ sequence: 2, content: [{ type: "text", text: "Notion native fixture answer" }] }],
            has_more: false,
          };
        else {
          res.writeHead(400).end("{}");
          return true;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
        return true;
      }
      if (pathname.startsWith("/chat-denied/")) {
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "provider-body-secret-must-not-reach-ui" }));
        return true;
      }
      if (pathname.startsWith("/chat-provider/")) {
        if (pathname.endsWith("/models")) {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ data: [{ id: "ui-model" }] }));
          return true;
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Project read tools are always offered with an open project; only the owner's write grant drives the tool path.
        if (!JSON.stringify(body.tools ?? []).includes("fs_write_file")) {
          res.end(
            "data: " +
              JSON.stringify({ choices: [{ delta: { content: "Real provider fixture response" } }] }) +
              "\n\ndata: [DONE]\n\n",
          );
          return true;
        }
        if (body.messages.at(-1)?.role === "user") {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Waiting for approved write" } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "ui_call", function: { name: "fs_write_file", arguments: JSON.stringify({ path: "chat-proof.txt", content: "real-chat-approved" }) } }] } }] })}\n\n`,
          );
        } else
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "UI streaming tool complete" } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return true;
      }
      if (pathname === "/provider-probe") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return true;
      }
      if (pathname !== "/real-rpc") return false;
      let data = "";
      for await (const c of req) {
        data += c;
        if (data.length > 262144) throw Error("Oversized test request");
      }
      let request = {};
      try {
        request = JSON.parse(data || "{}");
        const { kind, name, input } = request;
        const value =
          kind === "view"
            ? view
            : kind === "tool"
              ? await tool.call(name, input)
              : kind === "product"
                ? await control.request(name, input)
                : kind === "decide"
                  ? await controller.decide(name, input.decision)
                  : kind === "action"
                    ? await controller.startPairing(input)
                    : true;
        if (kind === "product" && name === "projects.inspect") {
          inspectionCalls++;
          await inspectionGate;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value }));
      } catch (error) {
        // A failed product request answers like the tray's IPC (main.ts): a fixed message and a diagnostic.
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            value:
              request.kind === "product"
                ? productFailure(String(request.name), error)
                : { ok: false, message: "Service rejected operation" },
          }),
        );
      }
      return true;
    },
    get shim() {
      return `window.crot={onView(fn){this.render=fn},async ready(){this.render(await this.request('view'));setInterval(async()=>{try{this.render(await this.request('view'))}catch{}},150)},async request(kind,name,input={}){const r=await fetch('/real-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,name,input})});return (await r.json()).value},product(name,input){return this.request('product',name,input)},tool(name,input){return this.request('tool',name,input)},action(name,input){return this.request('action',name,input)},decide(name,decision){return this.request('decide',name,{decision})},repairL1:async()=>({ok:false})};window.serviceTest=${JSON.stringify({ projectPath: path.join(base, "second"), command: process.execPath, mcpFixture: path.resolve("tests/fixtures/product-mcp.mjs") })};`;
    },
    async verify() {
      const r = await control.request("projects.list");
      const result = await tool.call("crot_status", {});
      const status = JSON.parse(result.content[0].text);
      return { projects: r.projects.length, active: r.active, endpoint, confinement: status.confinement };
    },
    /** The shipped extension's loopback client (built modules) against the real service's discovery port. */
    async startExtension(port) {
      extension?.stop();
      const credential = JSON.parse(await readFile(path.join(extensionDir, ".bridge-secret.json"), "utf8"));
      extension = await loopbackExtension(port, credential);
      return extension;
    },
    async close() {
      extension?.stop();
      releaseInspection?.();
      controller?.stop();
      control?.close();
      await tool?.close();
      await promisify(execFile)(process.execPath, [bin, "service", "stop"], { env, timeout: 15000 }).catch(() => {});
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * A browser without the native host: the release extension's origin, its real
 * LoopbackLink + HostConnection (extension/dist), a WebSocket over node:http
 * that sends the Origin header like the browser does, and one open tab.
 */
async function loopbackExtension(port, credential) {
  const { LoopbackLink } = await import("../extension/dist/extension/src/loopback.js");
  const { HostConnection } = await import("../extension/dist/extension/src/host-connection.js");
  const { connectWebSocket } = await import("../dist/tunnel/websocket.js");
  const origin = "chrome-extension://bllcepanlhojbddfbbpegmnokpaakool";
  const { version } = JSON.parse(await readFile(path.resolve("extension/manifest.json"), "utf8"));
  const browser = { name: "Chromium", version: "140.0.0.0", extensionVersion: version };
  const items = {};
  const storage = {
    async get(key) {
      return key in items ? { [key]: JSON.parse(JSON.stringify(items[key])) } : {};
    },
    async set(values) {
      Object.assign(items, JSON.parse(JSON.stringify(values)));
    },
  };
  const socket = (url) => {
    let connection,
      closed = false;
    const ws = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(text) {
        if (!connection?.sendText(text)) throw Error("The WebSocket is not open");
      },
      close(code = 1000, reason = "") {
        if (connection) connection.close(code, reason);
        else closed = true;
      },
    };
    connectWebSocket(url, { headers: { Origin: origin }, maxMessageBytes: 1 << 24, timeoutMs: 5000 }).then(
      (c) => {
        if (closed) return c.close(1000, "");
        connection = c;
        c.attach({
          onMessage: (data, binary) => ws.onmessage?.({ data: binary ? data : data.toString("utf8") }),
          onClose: (code) => ws.onclose?.({ code }),
        });
        ws.onopen?.({});
      },
      () => {
        ws.onerror?.({});
        ws.onclose?.({ code: 1006 });
      },
    );
    return ws;
  };
  const link = new LoopbackLink({
    fetch: (url, init) => globalThis.fetch(url, { ...init, headers: { ...init.headers, Origin: origin } }),
    socket,
    storage,
    origin,
    browser,
    ports: [port],
  });
  await link.bootstrap(credential);
  const tab = {
    tabId: 1,
    windowId: 1,
    url: "https://example.com/",
    title: "Example Domain",
    active: true,
    discarded: false,
    groupedByCrot: false,
  };
  const connection = new HostConnection({
    runtime: {
      connectNative() {
        throw Error("Specified native messaging host not found.");
      },
      lastError: undefined,
    },
    browser,
    loopback: link,
    handlers: new Proxy(
      { "tabs.list": async () => ({ tabs: [tab] }) },
      {
        get: (target, command) =>
          target[command] ??
          (async () => {
            throw Error("Not available in this test browser");
          }),
      },
    ),
  });
  connection.ensureConnected();
  return {
    get view() {
      return link.view;
    },
    get state() {
      return connection.state;
    },
    stop: () => connection.stop(),
  };
}
