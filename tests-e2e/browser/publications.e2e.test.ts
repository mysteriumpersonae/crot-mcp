import { DesktopAuth } from "../../src/desktop-auth/store.js";
import { DesktopAuthController } from "../../src/desktop-auth/controller.js";
/** Shipped renderer + actual authenticated owner/MCP channels + real local OAuth/platform HTTP.
 * HTTP is a test-only replacement for Electron IPC, NOT proof of browser/terminal anti-bypass. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { TRAY_ASSETS } from "../../src/tray/assets.js";
import { parseProduct, type ProductMethod } from "../../src/service/product-protocol.js";
import { publicationFixture, fixtureImage, ownerRequest } from "../../tests/service/publications/fixture.js";
import { chromeExecutable } from "./harness.js";
import { waitFor } from "../../tests/helpers.js";
it(
  "agent prepares frozen media -> shipped review requires privacy and consent -> owner confirms -> processing/published -> journal; no replay or substitution",
  { timeout: 90_000 },
  async () => {
    const f = await publicationFixture(),
      profile = await mkdtemp(path.join(os.tmpdir(), "crot-pub-ui-"));
    let otp = "";
    const auth = await DesktopAuth.open(path.join(profile, "accounts.json"), {
      deliverCode: async (_email, code) => {
        otp = code;
        return "smtp";
      },
    });
    const registered = await auth.register("fixture_user", "fixture@example.test", "fixture-password-123");
    await auth.verify(registered.challengeId, otp);
    auth.logout();
    const authentication = new DesktopAuthController(auth, {}, async () => {
      throw Error("No live OAuth");
    });
    let origin = "",
      browser: ChildProcess | undefined,
      socket: WebSocket | undefined;
    let confirmed: Record<string, unknown> | undefined;
    const errors: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const u = new URL(req.url!, origin);
        if (u.pathname === "/_test-auth") {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 4096) throw Error("Fixture limit");
          }
          const { method, input } = JSON.parse(raw);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(await authentication.call(method, input)));
          return;
        }
        if (u.pathname === "/owner") {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 65536) throw Error("Fixture IPC input limit");
          }
          const { method, params } = JSON.parse(raw) as { method: ProductMethod; params: Record<string, unknown> };
          if (!parseProduct(method, params)) throw Error("Invalid owner request");
          if (method === "publications.confirm") confirmed = params;
          const result = await f.owner.request(method, params);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
          return;
        }
        if (u.pathname === "/test-ipc.js") {
          const view = {
            cards: [],
            modules: [],
            presets: [],
            clients: [],
            status: [],
            pairing: { available: false },
            connection: "connected",
            workspace: f.dirs.workspace,
            headline: "Publication fixture",
            browser: { state: "disconnected" },
          };
          res.setHeader("content-type", "text/javascript");
          res.end(
            `let render;window.crot={auth:async(method,input)=>{const r=await fetch('/_test-auth',{method:'POST',body:JSON.stringify({method,input})});return r.json();},product:async(method,params={})=>{const response=await fetch('/owner',{method:'POST',body:JSON.stringify({method,params})});return response.json();},onView(fn){render=fn;},ready(){render(${JSON.stringify(view)});},action:async()=>true,decide:async()=>true};`,
          );
          return;
        }
        const asset = TRAY_ASSETS[u.pathname];
        if (!asset) {
          res.writeHead(404).end();
          return;
        }
        let body = asset.body.replaceAll("crot-tray://app", origin).replace("connect-src 'none'", "connect-src 'self'");
        if (u.pathname === "/index.html") body = body.replace("<head>", '<head><script src="/test-ipc.js"></script>');
        res.setHeader("content-type", asset.type);
        res.end(body);
      })().catch((error) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "Fixture error" }));
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const draft = await f.prepare();
      f.hold(true);
      await rename(path.join(f.dirs.workspace, "image.png"), path.join(f.dirs.workspace, ".env.future"));
      await writeFile(path.join(f.dirs.workspace, "image.png"), "agent replacement after prepare");
      browser = spawn(
        chromeExecutable(),
        [
          `--user-data-dir=${profile}`,
          "--headless=new",
          "--remote-debugging-port=0",
          "--disable-background-networking",
          "--no-first-run",
          ...(process.env.CROT_E2E_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      let endpoint: string[] = [];
      await waitFor(async () => {
        try {
          endpoint = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
          return endpoint.length === 2;
        } catch {
          return false;
        }
      }, 15_000);
      socket = new globalThis.WebSocket(`ws://127.0.0.1:${endpoint[0]}${endpoint[1]}`);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(Error("CDP connection failed")), { once: true });
      });
      let next = 0;
      const pending = new Map<
        number,
        { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
      >();
      socket.addEventListener("message", (event) => {
        const m = JSON.parse(String(event.data));
        if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails));
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.error) p.reject(Error(m.error.message));
          else p.resolve(m.result);
        }
      });
      const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      const target = await send("Target.createTarget", { url: "about:blank" }),
        attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
        sid = String(attached.sessionId);
      const call = (method: string, params: Record<string, unknown> = {}) => send(method, params, sid);
      await call("Runtime.enable");
      const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return (result.result as { value: T }).value;
      };
      const until = (expression: string) => waitFor(async () => await evaluate<boolean>(expression), 15_000);
      const click = async (selector: string) => {
        const point = await evaluate<{ x: number; y: number }>(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      };
      await call("Page.navigate", { url: origin + "/index.html" });
      await until("document.readyState==='complete'&&!!window.crot");
      await evaluate("window.CrotI18n.setLanguage('en')");
      await click("#login");
      await evaluate(
        "document.getElementById('auth-username').value='fixture_user';document.getElementById('auth-password').value='fixture-password-123';document.getElementById('auth-form').requestSubmit()",
      );
      await until("!document.getElementById('plan-gate').hidden");
      await click("#skip-plan");
      await until(`document.querySelector('#action-dialog[data-publication-id="${draft.id}"]')?.open===true`);
      await until("document.querySelector('[data-publication-preview]')?.complete===true");
      expect(await evaluate("document.querySelector('[data-publication-preview]').naturalWidth")).toBe(1);
      expect(await evaluate("document.getElementById('publication-privacy').value")).toBe("");
      expect(await evaluate("document.getElementById('publication-confirm').disabled")).toBe(true);
      expect(await evaluate("document.getElementById('publication-terms').checked")).toBe(false);
      expect(await evaluate("document.getElementById('publication-commercial').disabled")).toBe(true);
      expect(await evaluate("document.getElementById('action-dialog').innerText.includes('@fixture')")).toBe(true);
      await click("#publication-confirm");
      await delay(50);
      expect(f.writes()).toBe(0);
      await evaluate(
        "const privacy=document.getElementById('publication-privacy');privacy.value='public';privacy.dispatchEvent(new Event('change',{bubbles:true}));",
      );
      expect(await evaluate("document.getElementById('publication-confirm').disabled")).toBe(true);
      await click("#publication-terms");
      await until("!document.getElementById('publication-confirm').disabled");
      // Defense in depth: even DOM tampering with an unavailable platform toggle must
      // preserve the shared disclosure validation. No unsupported settings are sent.
      await evaluate(
        "const disclosure=document.getElementById('publication-commercial');disclosure.checked=true;disclosure.dispatchEvent(new Event('change',{bubbles:true}));",
      );
      expect(await evaluate("document.getElementById('publication-confirm').disabled")).toBe(true);
      await click("#publication-own-brand");
      expect(await evaluate("document.getElementById('publication-confirm').disabled")).toBe(false);
      await evaluate("disclosure.checked=false;disclosure.dispatchEvent(new Event('change',{bubbles:true}));");
      expect(await evaluate("document.getElementById('publication-own-brand').checked")).toBe(false);
      expect(f.writes()).toBe(0);
      await click("#publication-confirm");
      await waitFor(() => f.writes() === 1);
      await until(
        "['queued','processing'].includes(document.querySelector('#action-dialog [data-publication-state]')?.dataset.publicationState)",
      );
      expect(confirmed).toBeDefined();
      expect(f.uploads[0]!.includes(fixtureImage)).toBe(true);
      f.hold(false);
      await until(
        "document.querySelector('#action-dialog [data-publication-state]')?.dataset.publicationState==='published'",
      );
      await expect(f.owner.request("publications.confirm", confirmed!)).rejects.toThrow("confirmation");
      const stranger = await f.newOwner();
      await expect(stranger.request("publications.confirm", confirmed!)).rejects.toThrow("confirmation");
      const journal = await ownerRequest<{ events: Array<{ type: string; publicationId?: string }> }>(
        f.owner,
        "monitoring.queryAudit",
        { limit: 200 },
      );
      expect(
        journal.events.some((event) => event.type === "publication.published" && event.publicationId === draft.id),
      ).toBe(true);
      await evaluate(
        "document.getElementById('action-dialog').close();document.getElementById('nav-monitoring').click();",
      );
      await until("document.getElementById('page').innerText.includes('publication.published')");
      expect(
        await evaluate<{ ok: boolean }>(
          `window.crot.product('publications.confirm',${JSON.stringify({ ...confirmed, accountId: "x:attacker", mediaPath: "replacement.png" })})`,
        ),
      ).toMatchObject({ ok: false });
      expect(f.writes()).toBe(1);
      expect(await f.audit()).not.toMatch(/fixture-access|fixture-refresh|fixture-code/);
      expect(errors).toEqual([]);
    } finally {
      socket?.close();
      if (browser && browser.exitCode === null) {
        const stopped = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
        browser.kill("SIGTERM");
        const timer = setTimeout(() => browser!.kill("SIGKILL"), 5000);
        await stopped;
        clearTimeout(timer);
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await f.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
