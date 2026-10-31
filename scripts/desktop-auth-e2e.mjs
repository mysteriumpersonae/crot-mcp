/* global document, window, innerWidth */
/** Shipped UI + actual local auth; only IPC/vault/Gmail verification are synthetic fixtures. */
import assert from "node:assert/strict";
import { URL } from "node:url";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { chromium } from "playwright-core";
import { TRAY_ASSETS, TRAY_CSP } from "../dist/tray/assets.js";
import { ProviderSettings, ProviderError } from "../dist/desktop-auth/providers.js";
import { authTestHarness } from "./auth-test-harness.mjs";
const out = path.resolve(process.env.CROT_AUTH_EVIDENCE || "artifacts/screen-01");
await mkdir(out, { recursive: true });
let stored = null;
const providers = new ProviderSettings(
  async () => ({
    getPassword: async () => stored,
    setPassword: async (v) => {
      stored = v;
    },
  }),
  async (v) => {
    if (v.appPassword !== "abcdefghijklmnop") throw new ProviderError("SMTP_VERIFY_FAILED");
  },
);
const auth = await authTestHarness({ providers });
const shim = `window.crot={${auth.shim}product:async(name)=>({ok:true,...(name==='projects.list'?{projects:[],active:''}:name==='accounts.list'?{accounts:[],pending:[]}:name==='tasks.list'?{tasks:[]}:{} )}),onView(fn){this.render=fn},ready(){this.render({cards:[],modules:[],presets:[],clients:[],status:[],remoteNotes:[],connection:'connecting',pairing:{available:false}})},action:async()=>false,decide:async()=>false};`;
let origin = "";
const server = createServer((req, res) => {
  void (async () => {
    const u = new URL(req.url, origin);
    if (await auth.handle(req, res, u.pathname)) return;
    if (u.pathname === "/fixture.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(shim);
      return;
    }
    if (u.pathname === "/axe.js") {
      res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(await readFile("node_modules/axe-core/axe.min.js", "utf8"));
      return;
    }
    const key = u.pathname === "/" ? "/index.html" : u.pathname,
      asset = TRAY_ASSETS[key];
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    let body = asset.body.replaceAll("crot-tray://app", origin).replace("connect-src 'none'", "connect-src 'self'");
    if (key === "/index.html")
      body = body
        .replace("; frame-ancestors 'none'", "")
        .replace("<head>", '<head><script src="/fixture.js"></script>');
    res
      .writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "content-security-policy": TRAY_CSP.replaceAll("crot-tray://app", origin).replace(
          "connect-src 'none'",
          "connect-src 'self'",
        ),
      })
      .end(body);
  })().catch(() => res.writeHead(500).end());
});
let browser;
const errors = [],
  shots = [],
  a11y = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    executablePath: process.env.CROT_E2E_CHROME || "/usr/local/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const start = async () => {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('#provider-bootstrap[data-ready="true"]').waitFor({ state: "attached" });
    await page.selectOption("#auth-language select", "ru");
  };
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(out, name + ".png");
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
  };
  const remain = async () => {
    assert(await page.locator("#auth-gate").isVisible());
    assert(await page.locator("#plan-gate").isHidden());
  };
  const values = {
    googleId: "123456789-fixture.apps.googleusercontent.com",
    googleSecret: "GOCSPX-fixture-not-live",
    githubId: "fixture123456789",
    githubSecret: "0123456789abcdef0123456789abcdef01234567",
    gmail: "fixture@gmail.com",
    appPassword: "abcdefghijklmnop",
  };
  const fillProviders = async (bad) => {
    for (const [id, value] of Object.entries(values)) {
      assert.equal(await page.getAttribute("#provider-" + id, "type"), "password");
      await page.fill("#provider-" + id, bad && id === "appPassword" ? "ponmlkjihgfedcba" : value);
    }
  };
  await start();
  assert(await page.locator("#provider-bootstrap").evaluate((el) => el.open));
  await shot("01-bootstrap-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("02-bootstrap-mobile");
  await page.locator("#provider-appPassword").scrollIntoViewIfNeeded();
  const lastField = await page.locator("#provider-appPassword").boundingBox();
  const saveButton = await page.locator("#provider-save").boundingBox();
  assert(lastField.y + lastField.height < saveButton.y);
  await shot("02b-bootstrap-mobile-scrolled");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await fillProviders(true);
  await page.click("#provider-save");
  await page.waitForFunction(() => document.getElementById("provider-feedback").textContent.includes("Gmail"));
  assert.equal(stored, null);
  for (const id of Object.keys(values)) assert.equal(await page.inputValue("#provider-" + id), "");
  await shot("03-bootstrap-error");
  await fillProviders(false);
  await page.click("#provider-save");
  await page.waitForFunction(() => !document.getElementById("provider-bootstrap").open);
  await remain();
  assert(stored);
  await start();
  assert.equal(await page.locator("#provider-bootstrap").evaluate((el) => el.open), false);
  await page.click("#provider-open");
  for (const id of Object.keys(values)) assert.equal(await page.inputValue("#provider-" + id), "");
  await page.keyboard.press("Escape");
  await page.click("#auth-submit");
  await remain();
  await page.fill("#auth-username", "qa_user");
  await page.fill("#work-email", "qa@example.test");
  await page.fill("#auth-password", "qa-password-123");
  await page.click("#password-toggle");
  assert.equal(await page.getAttribute("#auth-password", "type"), "text");
  await page.click("#password-toggle");
  for (const lang of ["ru", "en"]) {
    await page.selectOption("#auth-language select", lang);
    await shot("04-registration-" + lang);
    await page.addScriptTag({ url: origin + "/axe.js" });
    const violations = await page.evaluate(async () =>
      (
        await window.axe.run(document.querySelector("#auth-gate"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v) => v.id),
    );
    a11y.push({ lang, violations });
    assert.deepEqual(violations, []);
  }
  await page.selectOption("#auth-language select", "ru");
  await page.click("#auth-submit");
  await page.locator("#otp-form:not([hidden])").waitFor();
  await remain();
  const code = auth.codes.at(-1).code;
  await page.fill("#auth-code", code === "000000" ? "111111" : "000000");
  await page.click("#otp-submit");
  await page.waitForFunction(() => document.getElementById("auth-feedback").textContent.includes("Неверный"));
  await shot("05-wrong-otp");
  await remain();
  await page.fill("#auth-code", code);
  await page.click("#otp-submit");
  await page.locator("#plan-gate:not([hidden])").waitFor();
  await start();
  await page.click("#login");
  await page.fill("#auth-username", "qa_user");
  await page.fill("#auth-password", "wrong-password");
  await page.click("#auth-submit");
  await page.waitForFunction(() => document.getElementById("auth-feedback").textContent.includes("Неверный"));
  await remain();
  await shot("06-wrong-password");
  await page.fill("#auth-password", "qa-password-123");
  await page.click("#auth-submit");
  await page.locator("#plan-gate:not([hidden])").waitFor();
  await start();
  for (const p of ["google", "github"]) {
    await page.click("#" + p);
    await page.waitForFunction(() => document.getElementById("auth-feedback").textContent.includes("CLIENT_ID"));
    await remain();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      {
        result: "PASS",
        scope:
          "Shipped renderer and real password/OTP controller; test-only HTTP IPC and synthetic vault/SMTP verifier; no live owner credentials",
        shots,
        a11y,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("PASS Screen 01 + Admin Bootstrap UI, password/OTP, blocked invalid credentials, RU/EN, accessibility");
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await auth.close();
}
