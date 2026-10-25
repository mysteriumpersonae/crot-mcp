import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { TrayToolClient } from "../../src/tray/tool-client.js";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { makeTempDirs, makeServiceHost, type ServiceHost, type TempDirs, stopService, waitFor } from "../helpers.js";
import type { ProductMethod } from "../../src/service/product-protocol.js";
const bin = inject("crotMcpBin");
let dirs: TempDirs, host: ServiceHost, client: TrayToolClient, control: ControlClient | undefined, server: Server;
afterEach(async () => {
  control?.close();
  await client?.close();
  await host?.cleanup(bin);
  await dirs?.cleanup();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});
it(
  "real CrotService persists projects/vault, switches guarded workspace, probes connector, discovers MCP, cancels tasks and filters real audit",
  { timeout: 90000 },
  async () => {
    dirs = await makeTempDirs();
    host = await makeServiceHost(dirs.outside);
    let seenAuth = "";
    server = createServer((req, res) => {
      if (req.url === "/mcp") {
        const mcp = new McpServer({ name: "http-fixture", version: "1" });
        mcp.registerTool("http_echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
          content: [{ type: "text", text }],
        }));
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        void mcp
          .connect(transport)
          .then(() => transport.handleRequest(req, res))
          .catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        return;
      }
      if (req.url?.split("?")[0]?.endsWith("/models")) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ id: "fixture-model" }], has_more: false }));
        return;
      }
      seenAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const config = path.join(dirs.outside, "config.json"),
      audit = path.join(dirs.outside, "audit.jsonl");
    await writeFile(
      config,
      JSON.stringify({
        workspace: { root: dirs.workspace },
        permissions: {
          mode: "full_control",
          approvals: { untrustedContent: "off" },
          network: { allow: [`127.0.0.1:${port}`] },
        },
        audit: { sink: "file", path: audit },
      }),
    );
    client = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env: host.env });
    const call = async (name: string, args: unknown = {}) => {
      const r = (await client.call(name, args)) as { isError?: boolean; content: { text?: string }[] };
      if (r.isError) throw new Error(JSON.stringify(r));
      return JSON.parse(r.content[0]!.text!);
    };
    await call("fs_list_directory", { path: "." });
    control = await ControlClient.connect({
      stateDir: host.stateDir,
      privateFiles: createPrivateFileProtection(process.platform === "win32"),
    });
    expect(control).toBeDefined();
    const rpc = async (method: ProductMethod, params = {}) =>
      (await control!.request(method, params)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const original = await rpc("projects.list");
    const catalog = await rpc("connectors.list");
    expect(catalog.manifests.find((m: { id: string }) => m.id === "Remotion")).toMatchObject({
      kind: "local",
      command: "node",
    });
    expect(catalog.manifests.find((m: { id: string }) => m.id === "Runway")).toMatchObject({
      kind: "web",
      probe: "https://api.dev.runwayml.com/v1/organization",
    });
    await rpc("skills.create", {
      id: "custom-check",
      name: "Check Node",
      command: process.execPath,
      args: ["-e", 'console.log("{{value}}")'],
      workingDirectory: ".",
    });
    expect((await rpc("skills.list")).skills[0].id).toBe("custom-check");
    for (const provider of ["OpenAI", "Anthropic", "Local HTTP"]) {
      await rpc("chat.configure", {
        provider,
        endpoint: `http://127.0.0.1:${port}`,
        credential: "stage-b-provider-secret",
      });
      expect((await rpc("chat.testConnection", { provider })).models).toEqual(["fixture-model"]);
    }
    const policy = {
      mode: "targeted",
      domains: ["example.com"],
      blockedDomains: ["private.example.com"],
      sensitivePreset: true,
    };
    await rpc("browser.policy.set", policy);
    expect((await rpc("browser.policy.get")).policy).toEqual(policy);
    await expect(rpc("browser.policy.set", { ...policy, domains: ["*.example.com"] })).rejects.toThrow();
    await expect(rpc("onboarding.advance", { step: 2 })).rejects.toThrow();
    for (const step of [1, 2, 3, 4]) await rpc("onboarding.advance", { step });
    expect((await rpc("onboarding.status")).onboarding.completedStep).toBe(4);
    const diagnosis = await rpc("system.check");
    expect(diagnosis.report.node.version).toMatch(/^v/);
    expect(diagnosis.report.ports.status).toBe("available");
    expect(diagnosis.report.l1.sourceAccess).toBe("core-only");
    expect(JSON.stringify(diagnosis)).not.toContain("stage-b-provider-secret");

    const second = await rpc("projects.create", {
      path: path.join(dirs.outside, "project-two"),
      name: "Second project",
    });
    await rpc("projects.select", { id: second.project.id });
    expect((await rpc("browser.policy.get")).policy).toEqual(policy);
    await call("fs_write_file", { path: "real.txt", content: "real workspace content" });
    expect(await readFile(path.join(second.project.path, "real.txt"), "utf8")).toBe("real workspace content");
    expect((await call("crot_status")).workspace.root).toBe(second.project.path);
    await rpc("projects.toggleFavorite", { id: second.project.id });
    await rpc("connectors.configure", {
      id: "Custom HTTP API",
      credential: "fixture-secret-not-for-ui",
      endpoint: `http://127.0.0.1:${port}`,
      scopes: ["read"],
      projects: [second.project.id],
      agents: [],
    });
    expect(JSON.stringify(await rpc("connectors.list"))).not.toContain("fixture-secret-not-for-ui");
    expect((await rpc("connectors.testConnection", { id: "Custom HTTP API" })).connector.status).toBe("Connected");
    expect(seenAuth).toBe("Bearer fixture-secret-not-for-ui");
    const metadata = await readFile(path.join(host.stateDir, "product-state.json"), "utf8"),
      vault = await readFile(path.join(host.stateDir, "product-vault.enc"), "utf8");
    expect(metadata + vault).not.toContain("fixture-secret-not-for-ui");
    const added = await rpc("mcpServers.add", {
      name: "Fixture MCP",
      transport: "stdio",
      command: process.execPath,
      args: [path.resolve("tests/fixtures/product-mcp.mjs")],
    });
    const connected = await rpc("mcpServers.connect", { id: added.server.id });
    const confinement = (await call("crot_status")).confinement;
    if (confinement.available) expect((await rpc("skills.test", { id: "custom-check" })).ok).toBe(true);
    else await expect(rpc("skills.test", { id: "custom-check" })).rejects.toThrow();
    expect(confinement.sourceAccess).toBe("core-only");
    if (confinement.available) {
      expect(connected.server.status, JSON.stringify(connected.server.logs)).toBe("Connected");
      expect(connected.server.tools[0].name).toBe("echo");
      expect(connected.server.resources).toHaveLength(1);
      await expect(
        rpc("mcpServers.callTool", { id: added.server.id, tool: "echo", arguments: { text: "test" } }),
      ).rejects.toThrow();
      await rpc("mcpServers.setToolPolicy", { id: added.server.id, tool: "echo", allowed: true });
      expect(
        JSON.stringify(
          await rpc("mcpServers.callTool", { id: added.server.id, tool: "echo", arguments: { text: "roundtrip" } }),
        ),
      ).toContain("roundtrip");
      await expect(
        rpc("mcpServers.callTool", { id: added.server.id, tool: "echo", arguments: { text: 42 } }),
      ).rejects.toThrow();
      await rpc("mcpServers.disconnect", { id: added.server.id });
    } else {
      expect(connected.server.status).not.toBe("Connected");
      expect(JSON.stringify(connected.server.logs)).toContain("CONFINEMENT_UNAVAILABLE");
    }
    const httpAdded = await rpc("mcpServers.add", {
      name: "HTTP fixture",
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
    });
    const httpConnected = await rpc("mcpServers.connect", { id: httpAdded.server.id });
    expect(httpConnected.server.status, JSON.stringify(httpConnected.server.logs)).toBe("Connected");
    expect(httpConnected.server.tools[0].name).toBe("http_echo");
    await rpc("mcpServers.setToolPolicy", { id: httpAdded.server.id, tool: "http_echo", allowed: true });
    expect(
      JSON.stringify(
        await rpc("mcpServers.callTool", {
          id: httpAdded.server.id,
          tool: "http_echo",
          arguments: { text: "http-roundtrip" },
        }),
      ),
    ).toContain("http-roundtrip");
    await rpc("mcpServers.disconnect", { id: httpAdded.server.id });
    if (confinement.available) {
      const started = await call("process_start", {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: second.project.path,
      });
      const tasks = await rpc("tasks.list");
      const task = tasks.tasks.find((t: { processId?: string }) => t.processId === started.id);
      expect(task.state).toBe("Running");
      await rpc("tasks.cancel", { id: task.id });
      expect((await rpc("tasks.list")).tasks.find((t: { id: string }) => t.id === task.id).state).toBe("Cancelled");
    } else
      await expect(
        call("process_start", {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          cwd: second.project.path,
        }),
      ).rejects.toThrow("CONFINEMENT_UNAVAILABLE");
    await waitFor(async () =>
      JSON.stringify(await rpc("monitoring.queryAudit", { project: second.project.id })).includes(
        "filesystem.write_file",
      ),
    );
    const filtered = await rpc("monitoring.queryAudit", { project: second.project.id, type: "filesystem.write_file" });
    expect(filtered.events.length).toBeGreaterThan(0);
    expect(filtered.events.every((e: { type: string }) => e.type === "filesystem.write_file")).toBe(true);
    expect(JSON.stringify(await rpc("monitoring.exportReport"))).not.toContain("fixture-secret-not-for-ui");
    const agents = await rpc("agents.list");
    const agent = agents.agents.find((a: { name: string }) => a.name === "CROT Control Center");
    await rpc("agents.configure", {
      id: agent.id,
      projects: [original.active],
      browser: false,
      requestsPerMinute: 100,
      revoked: false,
    });
    await expect(call("fs_read_file", { path: "real.txt" })).rejects.toThrow();
    await rpc("agents.configure", {
      id: agent.id,
      projects: [],
      browser: true,
      requestsPerMinute: 100,
      revoked: false,
    });
    const revokeProcess = confinement.available
      ? await call("process_start", {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          cwd: second.project.path,
        })
      : undefined;
    const revokeTask = (await rpc("tasks.list")).tasks.find(
      (t: { processId?: string }) => revokeProcess && t.processId === revokeProcess.id,
    );
    await rpc("agents.configure", {
      id: agent.id,
      projects: [],
      browser: false,
      requestsPerMinute: 100,
      revoked: true,
    });
    if (revokeProcess)
      expect((await rpc("tasks.list")).tasks.find((t: { id: string }) => t.id === revokeTask.id).state).toBe(
        "Cancelled",
      );
    await rpc("agents.configure", {
      id: agent.id,
      projects: [],
      browser: true,
      requestsPerMinute: 100,
      revoked: false,
    });
    await rpc("projects.select", { id: original.active });
    expect((await rpc("projects.list")).projects.find((p: { id: string }) => p.id === second.project.id).favorite).toBe(
      true,
    );
    const writeTask = (await rpc("tasks.list")).tasks.find(
      (t: { operation: string }) => t.operation === "filesystem.writeFile",
    );
    await rpc("projects.select", { id: second.project.id });
    await rpc("tasks.retry", { id: writeTask.id });
    await waitFor(
      async () =>
        (await rpc("tasks.list")).tasks.filter(
          (t: { operation: string; state: string }) =>
            t.operation === "filesystem.writeFile" && t.state === "Completed",
        ).length >= 2,
    );
    // Restart the actual daemon; metadata, encrypted credentials, favorites and active project must survive.
    control!.close();
    control = undefined;
    await client.close();
    await stopService(bin, host.env);
    client = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env: host.env });
    await call("fs_list_directory", { path: "." });
    control = await ControlClient.connect({
      stateDir: host.stateDir,
      privateFiles: createPrivateFileProtection(process.platform === "win32"),
    });
    expect((await rpc("projects.list")).active).toBe(second.project.id);
    expect((await rpc("projects.list")).projects.find((p: { id: string }) => p.id === second.project.id).favorite).toBe(
      true,
    );
    expect((await rpc("connectors.testConnection", { id: "Custom HTTP API" })).connector.status).toBe("Connected");
    expect((await call("crot_status")).workspace.root).toBe(second.project.path);
    expect(JSON.stringify(await rpc("tasks.list"))).not.toContain("real workspace content");
  },
);
