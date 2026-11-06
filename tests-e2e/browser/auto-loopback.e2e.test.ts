import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import * as h from "./harness.js";

describe.runIf(process.platform === "linux")("automatic loopback with two real browser profiles", () => {
  let sb: h.Sandbox | undefined;
  let session: h.CrotSession | undefined;
  let control: ControlClient | undefined;
  let a: h.ChromeInstance | undefined;
  let b: h.ChromeInstance | undefined;
  let server: http.Server | undefined;
  it("provisions an unpacked extension and connects without native host or confirmation", async () => {
    await h.assertBuilt();
    sb = await h.createSandbox();
    const extensionDir = path.join(sb.base, "extension");
    await cp(h.EXTENSION_DIR, extensionDir, {
      recursive: true,
      filter: (source) => !source.includes(".bridge-secret.json"),
    });
    sb.env.CROT_BROWSER_EXTENSION_DIR = extensionDir;
    sb.env.CROT_BROWSER_AUTO_REGISTER = "off";
    const config = path.join(sb.base, "config.json");
    await writeFile(
      config,
      JSON.stringify({ version: 1, workspace: { root: sb.base }, permissions: { mode: "full_control" } }),
    );
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>${req.url === "/one" ? "First profile" : "Second profile"}</title>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    session = await h.startCrot(sb, config, path.join(sb.base, "audit.jsonl"));
    const secret = path.join(extensionDir, ".bridge-secret.json");
    await h.waitFor(
      async () => (await stat(secret).catch(() => undefined)) || undefined,
      15000,
      "private bootstrap file",
    );
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    const denied = await h.fails(session.client, "fs_read_file", { path: secret });
    expect(denied).toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringMatching(/CROT secrets/) });
    const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
    expect(manifest.web_accessible_resources).toBeUndefined();
    control = await ControlClient.connect({
      stateDir: path.join(sb.stateHome, "crot"),
      privateFiles: createPrivateFileProtection(false),
    });
    expect(control).toBeDefined();
    a = h.launchChrome(h.chromeExecutable(), sb, { extensionDir, startUrl: `http://127.0.0.1:${port}/one` });
    const profile2 = path.join(sb.base, "profile2");
    await mkdir(profile2);
    b = h.launchChrome(
      h.chromeExecutable(),
      { ...sb, profileDir: profile2 },
      { extensionDir, startUrl: `http://127.0.0.1:${port}/two` },
    );
    try {
      const status = await h.waitFor(
        async () => {
          const result = (await control!.request("browser.link.status", {})) as {
            link: { sessions: Array<{ id: string; transport: string }>; loopback: { pending: unknown[] } };
          };
          return result.link.sessions.length === 2 ? result.link : undefined;
        },
        60000,
        "two automatically authenticated loopback profiles",
      );
      expect(status.sessions.every((x) => x.transport === "loopback")).toBe(true);
      expect(status.loopback.pending).toEqual([]);
      expect(JSON.stringify(status)).not.toContain('"code"');
      const titles: string[] = [];
      for (const item of status.sessions) {
        await control!.request("browser.link.select", { id: item.id });
        const tabs = await h.ok<{ tabs: Array<{ title: string }> }>(session!.client, "browser_tabs_list");
        titles.push(...tabs.tabs.map((tab) => tab.title));
      }
      expect(titles).toContain("First profile");
      expect(titles).toContain("Second profile");
    } catch (error) {
      throw new Error(
        `${String(error)}\nA: ${a.output().slice(-6000)}\nB: ${b.output().slice(-6000)}\nService: ${session.stderr().slice(-6000)}`,
      );
    }
  });
  afterAll(async () => {
    control?.close();
    await session?.close().catch(() => undefined);
    await a?.stop().catch(() => undefined);
    await b?.stop().catch(() => undefined);
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (sb) await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
