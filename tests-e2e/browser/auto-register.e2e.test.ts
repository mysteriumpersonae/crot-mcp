import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { afterAll, describe, expect, it } from "vitest";
import * as h from "./harness.js";

// No browser install command or copied manifest: the normal service startup registers the host.
describe.runIf(process.platform === "linux")("service auto-registration with a real Chromium extension", () => {
  let sb: h.Sandbox | undefined;
  let session: h.CrotSession | undefined;
  let chrome: h.ChromeInstance | undefined;
  let control: ControlClient | undefined;
  let provider: http.Server | undefined;
  it("registers before a profile exists, connects, and exposes real tabs", async () => {
    await h.assertBuilt();
    const sandbox = await h.createSandbox();
    // Use the browser's normal config profile, not an unrelated --user-data-dir.
    const executable = h.chromeExecutable();
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
    const configName = version.includes("Chrome for Testing")
      ? "google-chrome-for-testing"
      : version.includes("Chromium")
        ? "chromium"
        : "google-chrome";
    sb = { ...sandbox, profileDir: path.join(sandbox.configHome, configName) };
    const requests: Array<{
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function?: { name: string } }>;
    }> = [];
    provider = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
        requests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const hasToolResult = body.messages.some((message) => message.role === "tool");
        const delta = hasToolResult
          ? { content: "Fixture received browser tabs." }
          : { tool_calls: [{ index: 0, id: "call_tabs", function: { name: "browser_tabs_list", arguments: "{}" } }] };
        res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as { port: number }).port;
    const config = path.join(sb.base, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        workspace: { root: sb.workspace },
        permissions: {
          mode: "sandbox",
          capabilities: ["browser.read", "network.access"],
          network: { allow: [`127.0.0.1:${port}`] },
        },
        browser: { enabled: true },
      }),
    );
    session = await h.startCrot(sb, config, path.join(sb.base, "audit.jsonl"));
    const manifest = path.join(sb.profileDir, "NativeMessagingHosts", `${h.NATIVE_HOST_NAME}.json`);
    await h.waitFor(
      async () => (await readFile(manifest, "utf8").catch(() => "")) || undefined,
      15_000,
      "startup host registration",
    );
    chrome = h.launchChrome(h.chromeExecutable(), sb);
    try {
      await h.waitFor(
        async () =>
          (await h.ok<{ state: string }>(session!.client, "browser_status")).state === "connected" ? true : undefined,
        60_000,
        "extension connection",
      );
      const tabs = await h.ok<{ tabs: unknown[] }>(session.client, "browser_tabs_list");
      expect(tabs.tabs.length).toBeGreaterThan(0);
      control = await ControlClient.connect({
        stateDir: path.join(sb.stateHome, "crot"),
        privateFiles: createPrivateFileProtection(false),
      });
      expect(control).toBeDefined();
      await control!.request("chat.configure", { provider: "Local HTTP", endpoint: `http://127.0.0.1:${port}/v1` });
      const started = (await control!.request("chat.start", {
        provider: "Local HTTP",
        model: "fixture",
        message: "Can you see my browser?",
        browserTools: true,
      })) as { id: string };
      const result = await h.waitFor(
        async () => {
          const value = (await control!.request("chat.poll", { id: started.id })) as {
            state: string;
            blocks: Array<{ type: string; name?: string; status?: string }>;
          };
          return value.state === "running" ? undefined : value;
        },
        20_000,
        "chat turn",
      );
      expect(result.state).toBe("completed");
      expect(result.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool", name: "browser_tabs_list", status: "completed" }),
        ]),
      );
      expect(requests[0]!.tools?.map((tool) => tool.function?.name)).toContain("browser_tabs_list");
      const toolResult = requests[1]!.messages.find((message) => message.role === "tool");
      expect(JSON.stringify(toolResult?.content)).toContain("tabId");
    } catch (error) {
      throw new Error(
        `${String(error)}\nChromium: ${chrome.output().slice(-6000)}\nCROT: ${session.stderr().slice(-6000)}`,
      );
    }
  });
  afterAll(async () => {
    control?.close();
    await session?.close().catch(() => undefined);
    await chrome?.stop().catch(() => undefined);
    provider?.closeAllConnections();
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    if (sb && process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
