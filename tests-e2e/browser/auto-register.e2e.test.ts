import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  let actionSession: h.CrotSession | undefined;
  let chrome: h.ChromeInstance | undefined;
  let secondChrome: h.ChromeInstance | undefined;
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
    let fixtureTabId = 0;
    provider = http.createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><title>${req.url?.includes("second-profile") ? "Second profile tab" : "CROT test tab"}</title><p id="result">Real browser fixture</p><input id="field"><button id="button" onclick="document.querySelector('#result').textContent=document.querySelector('#field').value">Apply</button>`,
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number];
        requests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const hasToolResult = body.messages.some((message) => message.role === "tool");
        const toolMessage = body.messages.find((message) => message.role === "tool");
        const toolResult = toolMessage ? JSON.parse(String(toolMessage.content)) : undefined;
        const value = toolResult?.content?.[0]?.text ? JSON.parse(toolResult.content[0].text) : {};
        const pageQuestion = body.messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes("Прочитай"),
        );
        const delta = hasToolResult
          ? {
              content: pageQuestion
                ? `Страница: ${value.content}`
                : `Открытые вкладки: ${(value.tabs as Array<{ title: string }>).map((tab) => tab.title).join(", ")}`,
            }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: pageQuestion ? "call_page" : "call_tabs",
                  function: {
                    name: pageQuestion ? "browser_read_page" : "browser_list_tabs",
                    arguments: pageQuestion ? JSON.stringify({ tabId: fixtureTabId }) : "{}",
                  },
                },
              ],
            };
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
      }),
    );
    session = await h.startCrot(sb, config, path.join(sb.base, "audit.jsonl"));
    const manifest = path.join(sb.profileDir, "NativeMessagingHosts", `${h.NATIVE_HOST_NAME}.json`);
    await h.waitFor(
      async () => (await readFile(manifest, "utf8").catch(() => "")) || undefined,
      15_000,
      "startup host registration",
    );
    chrome = h.launchChrome(h.chromeExecutable(), sb, { startUrl: `http://127.0.0.1:${port}/fixture` });
    try {
      await h.waitFor(
        async () =>
          (await h.ok<{ state: string }>(session!.client, "browser_status")).state === "connected" ? true : undefined,
        60_000,
        "extension connection",
      );
      const tabs = await h.ok<{ tabs: Array<{ tabId: number; title: string }> }>(session.client, "browser_tabs_list");
      expect(tabs.tabs.length).toBeGreaterThan(0);
      fixtureTabId = tabs.tabs.find((tab) => tab.title === "CROT test tab")!.tabId;
      control = await ControlClient.connect({
        stateDir: path.join(sb.stateHome, "crot"),
        privateFiles: createPrivateFileProtection(false),
      });
      expect(control).toBeDefined();
      await control!.request("chat.configure", { provider: "Local HTTP", endpoint: `http://127.0.0.1:${port}/v1` });
      const started = (await control!.request("chat.start", {
        provider: "Local HTTP",
        model: "fixture",
        message: "Какие вкладки у меня сейчас открыты в браузере?",
        browserTools: true,
      })) as { id: string };
      const result = await h.waitFor(
        async () => {
          const value = (await control!.request("chat.poll", { id: started.id })) as {
            state: string;
            blocks: Array<{ type: string; name?: string; status?: string; text?: string }>;
          };
          return value.state === "running" ? undefined : value;
        },
        20_000,
        "chat turn",
      );
      expect(result.state).toBe("completed");
      expect(result.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool", name: "browser_list_tabs", status: "completed" }),
          expect.objectContaining({ type: "assistant", text: expect.stringContaining("CROT test tab") }),
        ]),
      );
      expect(requests[0]!.tools?.map((tool) => tool.function?.name)).toContain("browser_list_tabs");
      const toolResult = requests[1]!.messages.find((message) => message.role === "tool");
      expect(JSON.stringify(toolResult?.content)).toContain("tabId");
      await control!.request("browser.policy.set", {
        mode: "background",
        domains: [],
        blockedDomains: [],
        sensitivePreset: false,
      });
      const pageStarted = (await control!.request("chat.start", {
        provider: "Local HTTP",
        model: "fixture",
        message: "Прочитай текущую страницу",
        browserTools: true,
      })) as { id: string };
      const pageChat = await h.waitFor(
        async () => {
          const result = (await control!.request("chat.poll", { id: pageStarted.id })) as {
            state: string;
            blocks: Array<{ type: string; name?: string; status?: string; text?: string }>;
          };
          return result.state === "running" ? undefined : result;
        },
        20_000,
        "chat page read",
      );
      expect(pageChat.state).toBe("completed");
      expect(pageChat.blocks, JSON.stringify(pageChat.blocks)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool", name: "browser_read_page", status: "completed" }),
          expect.objectContaining({ type: "assistant", text: expect.stringContaining("Real browser fixture") }),
        ]),
      );
      expect(JSON.stringify(pageChat.blocks)).not.toContain("_crotTabPolicy");
      // Exercise the same guarded operations backing the chat aliases, without any manual grant.
      actionSession = await h.startCrot(sb, config, path.join(sb.base, "audit.jsonl"));
      const opened = await h.ok<{ tabId: number }>(actionSession.client, "browser_tab_open", {
        url: `http://127.0.0.1:${port}/fixture`,
        waitUntil: "load",
      });
      await h.ok(actionSession.client, "browser_navigate", {
        tabId: opened.tabId,
        url: `http://127.0.0.1:${port}/fixture?second=1`,
        waitUntil: "load",
      });
      await h.ok(actionSession.client, "browser_type", {
        tabId: opened.tabId,
        selector: "#field",
        text: "CROT_ACTION_OK",
      });
      await h.ok(actionSession.client, "browser_click", { tabId: opened.tabId, selector: "#button" });
      const page = await h.ok<{ content: string }>(actionSession.client, "browser_page_read", { tabId: opened.tabId });
      expect(page.content).toContain("CROT_ACTION_OK");
      const initial = (await control!.request("browser.policy.get", {})) as {
        policy: { mode: string; domains: string[]; blockedDomains: string[]; sensitivePreset: boolean };
        access: { read: boolean; navigation: boolean };
      };
      expect(initial.access).toMatchObject({ read: true, navigation: true });
      await control!.request("browser.access.set", { read: false, navigation: true });
      expect((await h.fails(session.client, "browser_tabs_list")).code).toBe("PERMISSION_DENIED");
      await control!.request("browser.access.set", { read: true, navigation: true });
      expect((await h.ok<{ tabs: unknown[] }>(session.client, "browser_tabs_list")).tabs.length).toBeGreaterThan(0);
      await control!.request("browser.policy.set", { ...initial.policy, sensitivePreset: true });
      expect((await h.fails(session.client, "browser_page_read")).code).toBe("PERMISSION_DENIED");
      await control!.request("browser.policy.set", { ...initial.policy, automation: false });
      expect(await h.fails(session.client, "browser_click", { selector: "p" })).toMatchObject({
        code: "PERMISSION_DENIED",
        message: expect.stringContaining("turned off"),
      });
      expect(await h.fails(session.client, "browser_type", { selector: "p", text: "test" })).toMatchObject({
        code: "PERMISSION_DENIED",
        message: expect.stringContaining("turned off"),
      });
      await control!.request("browser.policy.set", { ...initial.policy, blockedDomains: ["127.0.0.1"] });
      expect((await h.fails(session.client, "browser_page_read")).code).toBe("BROWSER_PAGE_RESTRICTED");
      // Two real profiles share the same owner service; pinning must route to each independently.
      await control!.request("browser.policy.set", initial.policy);
      const profile2 = path.join(sb.base, "profile2");
      await mkdir(path.join(profile2, "NativeMessagingHosts"), { recursive: true });
      await copyFile(manifest, path.join(profile2, "NativeMessagingHosts", `${h.NATIVE_HOST_NAME}.json`));
      secondChrome = h.launchChrome(
        executable,
        { ...sb, profileDir: profile2 },
        { startUrl: `http://127.0.0.1:${port}/second-profile` },
      );
      const pooled = await h.waitFor(
        async () => {
          const result = (await control!.request("browser.link.status", {})) as {
            link: { sessions: Array<{ id: string; transport: string }> };
          };
          return result.link.sessions.length === 2 ? result.link : undefined;
        },
        60_000,
        "two browser profiles",
      );
      expect(pooled.sessions.every((item) => item.transport === "native")).toBe(true);
      expect(pooled.loopback?.pending ?? []).toEqual([]);
      const titles: string[] = [];
      for (const item of pooled.sessions) {
        await control!.request("browser.link.select", { id: item.id });
        const browserTabs = await h.ok<{ tabs: Array<{ title: string }> }>(session.client, "browser_tabs_list");
        titles.push(...browserTabs.tabs.map((tab) => tab.title));
      }
      expect(titles).toContain("CROT test tab");
      expect(titles).toContain("Second profile tab");
      expect(JSON.stringify(pooled)).not.toContain('"code"');
      await secondChrome.stop();
      secondChrome = undefined;
      await h.waitFor(
        async () => {
          const result = (await control!.request("browser.link.status", {})) as { link: { sessions: unknown[] } };
          return result.link.sessions.length === 1 ? true : undefined;
        },
        30_000,
        "second browser disconnect",
      );
      expect((await h.ok<{ tabs: unknown[] }>(session.client, "browser_tabs_list")).tabs.length).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(
        `${String(error)}\nChromium: ${chrome.output().slice(-6000)}\nCROT: ${session.stderr().slice(-6000)}`,
      );
    }
  });
  afterAll(async () => {
    control?.close();
    await actionSession?.close().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await secondChrome?.stop().catch(() => undefined);
    await chrome?.stop().catch(() => undefined);
    provider?.closeAllConnections();
    if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
    if (sb && process.env.CROT_E2E_KEEP !== "1")
      await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
