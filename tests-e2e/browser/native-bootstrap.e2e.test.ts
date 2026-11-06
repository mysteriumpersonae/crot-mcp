import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import * as h from "./harness.js";

describe.runIf(process.platform === "linux")("native credential bootstrap in real Chromium", () => {
  let sb: h.Sandbox | undefined;
  let session: h.CrotSession | undefined;
  let control: ControlClient | undefined;
  let chrome: h.ChromeInstance | undefined;
  let witness: h.CdpWitness | undefined;
  let fixture: h.FixtureServer | undefined;
  it("persists the credential from native messaging and reconnects without a host or bootstrap file", async () => {
    await h.assertBuilt();
    sb = await h.createSandbox();
    const extensionDir = path.join(sb.base, "extension");
    await cp(h.EXTENSION_DIR, extensionDir, {
      recursive: true,
      filter: (source) => !source.includes(".bridge-secret.json"),
    });
    sb.env.CROT_BROWSER_AUTO_REGISTER = "off";
    sb.env.CROT_BROWSER_EXTENSION_DIR = "off";
    await h.installNativeHost(sb);
    const config = path.join(sb.base, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace: { root: sb.workspace } }));
    session = await h.startCrot(sb, config, path.join(sb.base, "audit.jsonl"));
    control = await ControlClient.connect({
      stateDir: path.join(sb.stateHome, "crot"),
      privateFiles: createPrivateFileProtection(false),
    });
    expect(control).toBeDefined();
    fixture = await h.startFixtureServer();
    chrome = h.launchChrome(h.chromeExecutable(), sb, {
      extensionDir,
      remoteDebugging: true,
      startUrl: fixture.origin,
    });
    await h.waitFor(
      async () => {
        const result = (await control!.request("browser.link.status", {})) as {
          link: { sessions: Array<{ transport: string }> };
        };
        return result.link.sessions.some((item) => item.transport === "native") ? true : undefined;
      },
      60_000,
      "native session",
    );
    witness = await h.watchExtensionCdp(sb);
    await h.waitFor(
      async () => ((await witness!.hasLoopbackBootstrap()) ? true : undefined),
      20_000,
      "native credential stored privately",
    );
    witness.close();
    witness = undefined;
    await chrome.stop();
    chrome = undefined;
    for (const dir of [
      sb.profileDir,
      path.join(sb.configHome, "google-chrome"),
      path.join(sb.configHome, "chromium"),
      path.join(sb.configHome, "google-chrome-for-testing"),
    ])
      await rm(path.join(dir, "NativeMessagingHosts", `${h.NATIVE_HOST_NAME}.json`), { force: true });
    chrome = h.launchChrome(h.chromeExecutable(), sb, { extensionDir, startUrl: fixture.origin });
    const link = await h.waitFor(
      async () => {
        const result = (await control!.request("browser.link.status", {})) as {
          link: { sessions: Array<{ transport: string }>; loopback: { pending: unknown[] } };
        };
        return result.link.sessions.some((item) => item.transport === "loopback") ? result.link : undefined;
      },
      60_000,
      "loopback using persisted native credential",
    );
    expect(link.loopback.pending).toEqual([]);
    expect(JSON.stringify(link)).not.toContain('"code"');
    expect((await h.ok<{ tabs: unknown[] }>(session.client, "browser_tabs_list")).tabs.length).toBeGreaterThan(0);
  });
  afterAll(async () => {
    witness?.close();
    control?.close();
    await chrome?.stop().catch(() => undefined);
    await session?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    if (sb) await rm(sb.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
});
