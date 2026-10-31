/** Trusted return-page copy under the same nonce policy as the real loopback callback. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { createAppReturn } from "../../src/desktop-auth/return-to-app.js";
import { callbackPage } from "../../src/desktop-auth/callback-page.js";
import { chromeExecutable } from "./harness.js";

it("renders responsive OAuth result cards and removes callback parameters under CSP", async () => {
  let success = true;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; img-src data:; style-src 'nonce-fixture'; script-src 'nonce-fixture'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(callbackPage(success, success, "fixture"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const out = path.join(process.env.CROT_E2E_ARTIFACTS || "artifacts", "screen-01");
    await mkdir(out, { recursive: true });
    for (const ok of [true, false]) {
      success = ok;
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/callback?code=fixture&state=fixture`,
        );
        await page.waitForFunction(() => location.search === "");
        await expect(page.locator("h1").textContent()).resolves.toBe(
          ok ? "Вы вошли в CROT" : "Sign-in wasn’t completed",
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator("button").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
          44,
        );
        await page.screenshot({ path: path.join(out, `oauth-${ok ? "success" : "failure"}-${width}.png`) });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

it("Continue in CROT activates the existing native-window callback through a real browser POST", async () => {
  let activated = 0;
  const server = createServer((_req, res) => {
    const returnOrigin = new URL(link.url).origin;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-fixture'; script-src 'nonce-fixture'; form-action 'none'; connect-src ${returnOrigin}; frame-ancestors 'none'`,
    });
    res.end(callbackPage(true, true, "fixture", link.url));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = await createAppReturn(origin, () => {
    activated++;
    return true;
  });
  const browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + "/oauth/callback?code=fixture&state=fixture");
    await page.waitForFunction(() => location.search === "");
    const out = path.join(process.env.CROT_E2E_ARTIFACTS || "artifacts", "screen-01");
    await mkdir(out, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 844 });
    expect(await page.locator("#continue").isEnabled()).toBe(true);
    await page.screenshot({ path: path.join(out, "oauth-continue-active.png") });
    await page.getByRole("button", { name: "Продолжить в CROT" }).click();
    await page.waitForFunction(() =>
      document.getElementById("return-hint")?.textContent?.startsWith("Окно CROT открыто"),
    );
    expect(activated).toBe(1);
    await page.screenshot({ path: path.join(out, "oauth-continue-activated.png") });
    expect(await page.content()).not.toContain("fixture&state");
  } finally {
    await browser.close();
    link.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
