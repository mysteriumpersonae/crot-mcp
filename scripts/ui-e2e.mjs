import { authTestHarness } from "./auth-test-harness.mjs";
/** Real Chromium rendering of shipped UI assets with an owner-IPC fixture.
 * Existing Electron/service and browser-bridge suites remain the integration gates.
 * No live Stripe/native installer qualification is claimed by this visual suite.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ReleaseDownloads } from "../dist/cloud-relay/downloads.js";
import { TRAY_ASSETS } from "../dist/tray/assets.js";
import { PORTAL_HTML, PORTAL_CSS, PORTAL_SCRIPT, LANDING_HTML } from "../dist/account-service/portal.js";

const authentication = await authTestHarness();
const agentsMode = process.argv.includes("--agents");
const serviceMode = process.argv.includes("--service") || agentsMode;
const real = serviceMode ? await (await import("./ui-service-harness.mjs")).serviceHarness() : undefined;
const repo = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(
  process.env.CROT_E2E_ARTIFACTS ?? path.join(repo, "artifacts"),
  agentsMode ? "agents-ui" : serviceMode ? "service-ui" : "flagship-ui",
);
await mkdir(artifacts, { recursive: true });
const fixture = {
  workspace: "/workspace/project",
  connection: "connected",
  headline: "CROT is running",
  cards: [],
  status: [
    { label: "Service", value: "running, pid 4242", marks: [], length: 0 },
    { label: "Account", value: "user_01CANARY", marks: [], length: 0 },
  ],
  presets: [
    { value: "require-approval", label: "Ask for every action", selected: true, available: true },
    { value: "autonomous-browser", label: "Autonomous browser", selected: false, available: true },
    { value: "off", label: "Off (no built-in approvals)", selected: false, available: true },
  ],
  remoteMode: false,
  fullControl: false,
  fullControlNote: "RFC 9207 not advertised",
  remoteNotes: [],
  clients: [],
  pairing: { state: "unpaired", available: true, action: "pair", lines: ["user_01CANARY"] },
  commercial: { state: "current", plan: "free", status: "active", entitled: false, maxDevices: 0, deviceCount: 0 },
  agents: { stdio: 1, httpSessions: 0, remoteClients: 0 },
  browser: { state: "connected", name: "Chromium" },
  modules: [
    { title: "Local service", value: "Online", ready: true },
    { title: "Browser & CDP", value: "Chrome connected", ready: true },
    { title: "L1 sandbox", value: "Setup required", ready: false, repair: true },
    { title: "Cloud tunnel", value: "Local mode", ready: false },
  ],
};
const shim = `window.fixture=${JSON.stringify(fixture)};window.actions=[];window.browserAccess={read:true,navigation:true};window.browserPolicy={mode:'targeted',domains:['reddit.com'],blockedDomains:['bank.com','binance.com'],sensitivePreset:false,activeTab:true};window.browserLink={state:'connected',browser:{name:'Google Chrome',version:'140',extensionVersion:'1.0.0'},transport:'native',cdp:true,manage:true,tabsRevision:1,loopback:{port:43115,conflicts:[],pending:[],pairings:[]}};window.crot={${authentication.shim}product:async(name,input={})=>{window.actions.push([name,input]);const p={id:'fixture-project',name:'project',path:'/workspace/project',favorite:false,tools:[],agents:[],connectors:[]};return {ok:true,...(name==='accounts.list'?{accounts:['youtube','tiktok','x','github','notion'].map(provider=>({provider,state:'disconnected'})),pending:[]}:name==='projects.list'?{projects:[p],active:p.id}:name==='connectors.list'?{connectors:[]}:name==='mcpServers.list'?{servers:[]}:name==='agents.list'?{agents:[],calls:[]}:name==='tasks.list'?{tasks:[]}:name==='monitoring.queryAudit'?{events:[]}:name==='monitoring.metrics'?{tasks:{running:0,total:0},workspace:p.id,connectedServers:0}:name==='browser.policy.get'?{policy:window.browserPolicy,access:window.browserAccess}:name==='browser.access.set'?(window.browserAccess=input,{access:input}):name==='browser.policy.set'?(window.browserPolicy=input,{policy:input,access:window.browserAccess}):name==='browser.link.select'?(window.browserLink.selection=input.id,{link:window.browserLink}):name==='browser.link.status'||name==='browser.link.approve'||name==='browser.link.reject'?{link:window.browserLink}:{})}},tool:async(name,input)=>{window.actions.push([name,input]);return {content:[{type:"text",text:JSON.stringify(name==="fs_list_directory"?{entries:[{path:"README.md",type:"file"}]}:name==="fs_stat"?{exists:true,type:"directory"}:name==="fs_read_file"?{content:"# Test project"}:name==="browser_tabs_list"?{tabs:[{tabId:42,windowId:1,title:"Test tab",url:"https://example.test/",active:true,groupedByCrot:false},{tabId:43,windowId:1,title:"CROT research",url:"https://reddit.com/r/programming",active:false,groupedByCrot:true}]}:{ok:true})}]}},repairL1:async()=>{window.actions.push(["repair-l1"]);return {ok:true,available:false}},onView(fn){window.render=fn},ready(){window.render(window.fixture)},decide:async(...args)=>{window.actions.push(args);return true},action:async(...args)=>{window.actions.push(args);return true}};window.chrome={runtime:{getURL:p=>'/extension/'+p,sendMessage:async(m)=>{window.actions.push(['extension',m.type]);return m.type==='crot.ui.openApp'?{ok:true}:{connection:'disconnected'}}},tabs:{create:async(o)=>{window.actions.push(['tab',o.url]);return o},query:async()=>[{status:'complete',windowId:1,groupId:-1}]},tabGroups:{query:async()=>[]}};`;
const inject = (html) => html.replace("<head>", '<head><script src="/ui-fixture.js"></script>');
let origin;
const downloads = new ReleaseDownloads({ origin: "https://relay-staging.crot.network" });
const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url, origin).pathname;
    if (await authentication.handle(req, res, pathname)) return;
    if (real && (await real.handle(req, res, pathname))) return;
    if (await downloads.handle(req, res, pathname)) return;
    let body, type;
    const key = pathname === "/control-center" ? "/index.html" : pathname;
    if (Object.hasOwn(TRAY_ASSETS, key)) {
      body = TRAY_ASSETS[key].body.replaceAll("crot-tray://app", origin);
      body = body.replace("connect-src 'none'", "connect-src 'self'"); // Test IPC bridge only; production keeps network denied.
      type = TRAY_ASSETS[key].type;
    } else if (pathname === "/ui-fixture.js") {
      body = real ? real.shim.replace("window.crot={", "window.crot={" + authentication.shim) : shim;
      type = "text/javascript";
    } else if (pathname === "/portal.css") {
      body = PORTAL_CSS;
      type = "text/css";
    } else if (pathname === "/portal.js") {
      body = PORTAL_SCRIPT;
      type = "text/javascript";
    } else if (pathname === "/portal") {
      body = PORTAL_HTML;
      type = "text/html";
    } else if (pathname === "/welcome") {
      body = LANDING_HTML;
      type = "text/html";
    } else if (pathname === "/portal/config") {
      res.writeHead(503).end();
      return;
    } else if (
      [
        "/extension/popup-geometry.css",
        "/extension/i18n.js",
        "/extension/welcome.js",
        "/extension/popup.html",
        "/extension/popup.js",
        "/extension/welcome.html",
        "/extension/welcome.css",
        "/extension/ui.css",
        "/extension/popup.css",
      ].includes(pathname)
    ) {
      body = await readFile(path.join(repo, pathname.slice(1)), "utf8");
      type = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
    } else {
      res.writeHead(404).end();
      return;
    }
    if (type.startsWith("text/html")) body = inject(body);
    res
      .writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'self'; img-src data:; style-src 'self' 'sha256-${createHash("sha256").update(PORTAL_CSS).digest("base64")}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      })
      .end(body);
  })().catch(() => res.writeHead(500).end());
});
const profile = await mkdtemp(path.join(os.tmpdir(), "crot-ui-e2e-"));
let browser, socket;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  if (real) await real.start(origin);
  const executable = process.env.CROT_E2E_CHROME;
  if (!executable) throw new Error("CROT_E2E_CHROME must identify the qualified Chromium binary");
  browser = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(process.env.CROT_E2E_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port, route;
  const deadline = Date.now() + 15000;
  while (!port) {
    try {
      [port, route] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    } catch {
      if (Date.now() > deadline) throw new Error("Chromium did not start");
      await delay(50);
    }
  }
  socket = new globalThis.WebSocket(`ws://127.0.0.1:${port}${route}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const runtimeErrors = [];
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data)),
      p = pending.get(m.id);
    if (m.method === "Runtime.exceptionThrown")
      runtimeErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (p) {
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      socket.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  await call("Runtime.enable");
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("UI evaluation failed: " + expression);
    return result.result.value;
  }
  async function until(expression) {
    const end = Date.now() + 15000;
    for (;;) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        /* navigation changes the context */
      }
      if (Date.now() > end)
        throw new Error(
          "UI condition timed out: " +
            expression +
            "\n" +
            JSON.stringify(
              await evaluate("({text:document.body.innerText,errors:" + JSON.stringify(runtimeErrors) + "})"),
            ),
        );
      await delay(50);
    }
  }
  function assert(value, message) {
    if (!value) throw new Error(message);
  }
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const size = (width, height) =>
    call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  async function screenshot(name) {
    assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), name + " overflows");
    const { cssContentSize } = await call("Page.getLayoutMetrics");
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
    });
    await writeFile(path.join(artifacts, name + ".png"), Buffer.from(data, "base64"));
  }
  const navigate = async (pathname) => {
    await call("Page.navigate", { url: origin + pathname });
    await until("document.readyState === 'complete'");
    await delay(100);
  };
  if (real && !agentsMode) {
    await (
      await import("./ui-service-scenarios.mjs")
    ).runServiceScenarios({ real, call, evaluate, until, size, screenshot, navigate, artifacts });
  } else if (agentsMode) {
    await (
      await import("./ui-agents-scenarios.mjs")
    ).runAgentsScenarios({ real, evaluate, until, size, screenshot, navigate, call, artifacts, assert });
    if (runtimeErrors.length) throw Error(runtimeErrors.join("\n"));
  } else if (process.argv.includes("--chat-groups")) {
    await (
      await import("./ui-chat-groups-scenarios.mjs")
    ).runChatGroupScenarios({ evaluate, until, size, screenshot, navigate, call, artifacts, assert });
    if (runtimeErrors.length) throw new Error(JSON.stringify(runtimeErrors));
  } else if (process.argv.includes("--onboarding")) {
    await (
      await import("./ui-onboarding-scenarios.mjs")
    ).runOnboardingScenarios({ evaluate, until, size, screenshot, navigate, assert });
    if (runtimeErrors.length) throw new Error(JSON.stringify(runtimeErrors));
  } else {
    await (
      await import("./ui-onboarding-scenarios.mjs")
    ).runOnboardingScenarios({ evaluate, until, size, screenshot, navigate, assert });
    const route = async (name) => {
      const slug = name.toLowerCase().replaceAll(" ", "-");
      if (
        !(await evaluate(`!!document.getElementById('nav-${slug}')&&!document.getElementById('nav-${slug}').hidden`))
      ) {
        if (!(await evaluate(`!!document.getElementById('tool-${slug}')`))) await click("nav-projects");
        await click("tool-" + slug);
      } else await click("nav-" + slug);
    };
    await evaluate(
      "window.CrotI18n.setLanguage('en');const s=document.getElementById('global-search');s.value='GitHub';s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))",
    );
    await until("document.querySelector('#action-dialog .search-result')?.textContent.includes('GitHub')");
    await evaluate("document.getElementById('action-dialog').close()");
    const sections = [
      "Home",
      "Projects",
      "Agents",
      "Connectors",
      "MCP Servers",
      "Browser",
      "Files",
      "Terminal",
      "Git",
      "Docker",
      "Tasks",
      "Monitoring",
      "Settings",
    ];
    for (const lang of ["en", "ru"]) {
      await evaluate(`window.CrotI18n.setLanguage('${lang}')`);
      for (const section of sections) {
        const slug = section.toLowerCase().replaceAll(" ", "-");
        await route(section);
        assert(
          await evaluate(
            `(document.getElementById('tool-${slug}')||document.getElementById('nav-${slug}')).getAttribute('aria-current')==='page'`,
          ),
          section + " not active",
        );
        assert(await evaluate("document.querySelector('#page h1')!==null"), "missing page heading: " + section);
        if (section === "Projects") {
          assert(
            await evaluate("document.querySelectorAll('[data-project-tab]').length===7"),
            "project must have seven tabs",
          );
          for (const tab of ["Overview", "Files", "Git", "Tasks", "Agents", "Connectors", "Settings"]) {
            await evaluate(`document.querySelector('[data-project-tab="${tab}"]').click()`);
            assert(
              await evaluate(
                `document.querySelector('[data-project-tab="${tab}"]').getAttribute('aria-selected')==='true'`,
              ),
              "project tab failed: " + tab,
            );
          }
          await evaluate("document.querySelector('[data-project-tab=Overview]').click()");
        }
        if (section === "Browser") {
          // The mockup: no context tools row and no legacy policy form; status card, three policy cards and tabs.
          assert(
            await evaluate(
              "!document.querySelector('#page .context-tools')&&!document.querySelector('select[aria-label=\"Tab mode\"]')&&document.querySelectorAll('#browser-page>.browser-card').length===4",
            ),
            "browser screen must follow the mockup without tool row or legacy form",
          );
          await until(
            "document.getElementById('browser-status').dataset.state==='connected'&&document.querySelectorAll('#browser-tabs .browser-tab').length===2&&!document.querySelector('#browser-page input[role=switch]:disabled')",
          );
          if (lang === "ru") {
            await size(1280, 800);
            await delay(150);
            assert(
              await evaluate(
                "document.querySelector('.browser-card-danger').getBoundingClientRect().bottom <= innerHeight",
              ),
              "all three browser policy cards must fit in a 1280x800 viewport",
            );
            await screenshot("browser-1280x800-ru");
            await size(1054, 820);
            await screenshot("browser-compact-1054-ru");
            await size(1280, 820);
          }
          const expected =
            lang === "ru"
              ? [
                  "Браузер",
                  "CROT Extension — Подключено и активно",
                  "Управление расширением ↗",
                  "Область действия (Tabs Control)",
                ]
              : [
                  "Browser",
                  "CROT Extension — Connected and active",
                  "Manage extension ↗",
                  "Scope of action (Tabs Control)",
                ];
          assert(
            await evaluate(
              `(()=>{const t=document.getElementById('browser-page').innerText;return ${JSON.stringify(expected)}.every(x=>t.includes(x))})()`,
            ),
            "browser screen text missing in " + lang,
          );
          assert(
            await evaluate(
              "JSON.stringify([...document.querySelectorAll('#browser-page input[role=switch]')].map(i=>[i.dataset.switch,i.checked]))===JSON.stringify([['active',true],['background',false],['targeted',true],['sessions',true],['automation',true]])",
            ),
            "browser switches must reflect the saved policy",
          );
          assert(
            await evaluate(
              "document.querySelector('#browser-page input[aria-label]:not([role])').value==='reddit.com'&&document.querySelector('#browser-page textarea').value==='bank.com\\nbinance.com'",
            ),
            "browser domains must reflect the saved policy",
          );
        }
        if (section === "Settings") {
          assert(
            await evaluate("document.querySelectorAll('[data-setting]').length===12"),
            "settings must have twelve sections including Subscription",
          );
          for (const setting of [
            "General",
            "Device & Account",
            "Subscription",
            "Remote Access",
            "Security",
            "Permissions",
            "Browser",
            "Network",
            "Integrations",
            "MCP",
            "Updates & Diagnostics",
            "About",
          ]) {
            await evaluate(`document.querySelector('[data-setting="${setting}"]').click()`);
            assert(
              await evaluate(
                `document.querySelector('[data-setting="${setting}"]').getAttribute('aria-pressed')==='true'`,
              ),
              "settings navigation failed: " + setting,
            );
            if (setting === "Subscription") {
              assert(
                await evaluate("document.querySelector('.settings-body').innerText.includes('$5')"),
                "subscription must show approved pricing",
              );
              assert(
                await evaluate(
                  "!document.querySelector('.settings-body').innerText.includes('Verified paid-through date:')",
                ),
                "Free must not invent a renewal date",
              );
              await evaluate(
                "fixture.commercial={state:'current',plan:'pro',status:'active',entitled:true,expiresAt:1900000000000};render(fixture)",
              );
              assert(
                await evaluate(
                  "document.querySelector('.settings-body').innerText.includes('Verified paid-through date:')",
                ),
                "verified subscription expiry must be shown",
              );
              await evaluate(
                "fixture.commercial={state:'current',plan:'free',status:'active',entitled:false,maxDevices:0,deviceCount:0};render(fixture)",
              );
            }
          }
          await evaluate("document.querySelector('[data-setting=General]').click()");
        }
        await delay(80);
        if (lang === "en" || ["Home", "Projects", "Connectors", "Browser", "Settings"].includes(section))
          await screenshot(slug + "-" + lang);
      }
    }
    // Browser screen: interlocked tab modes with autosave, then Scenario A (waiting, pairing, connected).
    await evaluate("window.CrotI18n.setLanguage('en')");
    await route("Browser");
    await until(
      "document.getElementById('browser-status').dataset.state==='connected'&&!document.querySelector('#browser-page input[role=switch]:disabled')",
    );
    await size(1054, 820);
    await screenshot("browser-compact-1054");
    await size(1584, 993);
    await screenshot("browser-compact-1584");
    await size(1280, 820);
    await evaluate(
      "window.originalProduct=window.crot.product;window.crot.product=(name,input)=>name==='browser.link.status'?Promise.reject(new Error('fixture unavailable')):window.originalProduct(name,input)",
    );
    await until("document.getElementById('browser-status').dataset.state==='unknown'");
    assert(
      await evaluate("!document.getElementById('browser-status').innerText.includes('Connected and active')"),
      "failed status check must not show connected",
    );
    await evaluate("window.crot.product=window.originalProduct");
    await until("document.getElementById('browser-status').dataset.state==='connected'");
    await evaluate(
      "window.browserLink.sessions=[{id:'0123456789abcdef0123456789abcde1',browser:{name:'Google Chrome',version:'140'}},{id:'0123456789abcdef0123456789abcde2',browser:{name:'Google Chrome',version:'140'}}]",
    );
    await until("document.querySelector('#browser-status select')?.options.length===3");
    assert(
      await evaluate(
        "new Set([...document.querySelector('#browser-status select').options].map(x=>x.textContent)).size===3",
      ),
      "identical browser profiles must be distinguishable",
    );
    await evaluate(
      "(()=>{const s=document.querySelector('#browser-status select');s.value='0123456789abcdef0123456789abcde2';s.dispatchEvent(new Event('change'))})()",
    );
    await until("actions.some(a=>a[0]==='browser.link.select'&&a[1].id==='0123456789abcdef0123456789abcde2')");
    await evaluate("delete window.browserLink.sessions;delete window.browserLink.selection");
    const browserSwitch = (key) => evaluate(`document.querySelector('#browser-page [data-switch=${key}]').click()`);
    const lastPolicy = "actions.filter(a=>a[0]==='browser.policy.set').at(-1)?.[1]";
    // The Browser and Permissions screens edit the same owner policy.
    await route("Permissions");
    const permissionInput = (label) =>
      `([...document.querySelectorAll('#browser-permissions label')].find(l=>l.querySelector('span')?.textContent===${JSON.stringify(label)})?.querySelector('input'))`;
    await until(`${permissionInput("Browser access")}?.checked`);
    await evaluate(`${permissionInput("Browser access")}.click()`);
    await until(`window.browserAccess.read===false`);
    await evaluate(`${permissionInput("Browser access")}.click()`);
    await until(`window.browserAccess.read===true`);
    await evaluate(`${permissionInput("Allow auto-clicks and form filling")}.click()`);
    await until("window.browserPolicy.automation===false");
    await route("Browser");
    await until(
      "!document.querySelector('[data-switch=access]') && !document.querySelector('[data-switch=automation]')?.disabled && !document.querySelector('[data-switch=automation]')?.checked",
    );
    await browserSwitch("automation");
    await until("window.browserPolicy.automation!==false");

    await browserSwitch("background");
    await until(`${lastPolicy}?.mode==='background'`);
    assert(
      await evaluate("['active','targeted'].every(k=>!document.querySelector('[data-switch='+k+']').checked)"),
      "background search must turn the active-tab and target modes off",
    );
    await browserSwitch("background");
    assert(
      await evaluate("document.querySelector('[data-switch=background]').checked"),
      "the last tab mode must stay on",
    );
    await browserSwitch("active");
    await until(`${lastPolicy}?.mode==='active'&&!document.querySelector('[data-switch=background]').checked`);
    await browserSwitch("targeted");
    await until(`${lastPolicy}?.mode==='targeted'&&${lastPolicy}?.activeTab===true`);
    await evaluate(
      "(()=>{const i=document.querySelector('#browser-page input[aria-label]:not([role])');i.value='https://www.Example.com/path, news.ycombinator.com';i.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await until(`JSON.stringify(${lastPolicy}?.domains)==='["example.com","news.ycombinator.com"]'`);
    await browserSwitch("automation");
    await until(`${lastPolicy}?.automation===false`);
    await browserSwitch("sessions");
    await until(`${lastPolicy}?.sensitivePreset===true&&${lastPolicy}?.automation===false`);
    assert(
      await evaluate("document.getElementById('browser-saved').textContent.includes('Saved')"),
      "autosave must be confirmed by a compact notice",
    );
    await screenshot("browser-autosave");
    await evaluate(
      "window.browserPolicy={mode:'targeted',domains:['reddit.com'],blockedDomains:['bank.com','binance.com'],sensitivePreset:false,activeTab:true};window.browserLink={state:'waiting',tabsRevision:1,loopback:{port:43115,conflicts:[],pending:[],pairings:[]}}",
    );
    await until(
      "document.getElementById('browser-status').dataset.state==='waiting'&&document.querySelector('#browser-tabs .empty')",
    );
    assert(
      await evaluate(
        "(()=>{const t=document.getElementById('browser-status').innerText;return t.includes('CROT Extension — Waiting for connection')&&t.includes('Install extension ↗')&&t.includes('Check connection')})()",
      ),
      "waiting status card must offer installation and a connection check",
    );
    await screenshot("browser-waiting-en");
    await evaluate("window.CrotI18n.setLanguage('ru')");
    await until(
      "document.getElementById('browser-status').innerText.includes('CROT Extension — Ожидается подключение')&&document.getElementById('browser-status').innerText.includes('Установить расширение ↗')",
    );
    await screenshot("browser-waiting-ru");
    await size(1280, 1800);
    await screenshot("browser-waiting-ru-full");
    await size(1280, 820);
    await evaluate("window.CrotI18n.setLanguage('en')");
    await evaluate(
      "[...document.querySelectorAll('#browser-status button')].find(b=>b.textContent==='Install extension ↗').click()",
    );
    await until(
      "document.getElementById('action-dialog').open&&document.querySelector('#action-dialog a[href=\"https://crot.network/#download\"][target=_blank]')",
    );
    await evaluate("document.getElementById('action-dialog').close()");
    await evaluate(
      "window.browserLink={state:'connected',browser:{name:'Google Chrome',version:'140',extensionVersion:'1.0.0'},transport:'loopback',cdp:true,manage:true,tabsRevision:2,loopback:{port:43115,conflicts:[],pending:[],pairings:[]}}",
    );
    await until(
      "document.getElementById('browser-status').dataset.state==='connected'&&document.querySelectorAll('#browser-tabs .browser-tab').length===2",
    );
    assert(
      await evaluate("!document.querySelector('#browser-status .browser-code')"),
      "automatic connection must never show pairing codes",
    );
    await click("nav-home");
    assert(
      await evaluate(
        "document.querySelectorAll('.category-card').length===4 && document.querySelectorAll('.category-services .service-mini').length===16",
      ),
      "Home capability cards or service tiles missing",
    );
    assert(
      await evaluate(
        "document.querySelectorAll('.core-connectors path').length===4 && document.querySelectorAll('.core-connectors circle').length===8",
      ),
      "Home connector geometry missing",
    );
    assert(
      await evaluate(
        "!document.getElementById('page').innerText.includes('Finish the four-step') && !document.getElementById('page').innerText.includes('Loading…')",
      ),
      "Home leaked first-run loading content",
    );
    assert(
      await evaluate("document.querySelector('#nav-chat .chat-live')?.textContent==='Live'"),
      "Live bridge badge missing",
    );
    await click("account-avatar");
    assert(
      await evaluate(
        "!document.getElementById('account-menu').hidden && document.getElementById('account-avatar').getAttribute('aria-expanded')==='true'",
      ),
      "Profile menu did not open",
    );
    await screenshot("home-account-menu");
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    assert(await evaluate("document.getElementById('account-menu').hidden"), "Profile menu Escape failed");
    for (const lang of ["ru", "en"]) {
      await evaluate(`window.CrotI18n.setLanguage('${lang}')`);
      for (const [width, height] of [
        [1920, 1080],
        [1920, 600],
        [1584, 993],
        [1440, 900],
        [1280, 900],
        [1280, 820],
        [1280, 720],
        [1180, 680],
        [1100, 600],
        [960, 600],
      ]) {
        await size(width, height);
        await delay(60); // ResizeObserver aligns the four paths after the viewport settles.
        const fit = await evaluate(`(()=>{
          const content=document.querySelector('.content'),dashboard=document.querySelector('.home-dashboard');
          const visible=[...document.querySelectorAll('.home-active .sidebar-note,.home-active .sidebar>button'),...dashboard.querySelectorAll('.category-card,.category-card strong,.category-description,.category-services,.service-mini,.core-lens,.core-lens>*,.home-banner,.home-banner h2,.home-banner p,.home-banner button,.home-status-action')].filter(e=>e.getClientRects().length);
          const outside=visible.filter(e=>{const r=e.getBoundingClientRect();return r.top<0||r.left<0||r.bottom>innerHeight+1||r.right>innerWidth+1;}).map(e=>({class:e.className,text:e.textContent.slice(0,50),rect:JSON.stringify(e.getBoundingClientRect().toJSON())}));
          const lens=document.querySelector('.core-lens').getBoundingClientRect(),svg=document.querySelector('.core-connectors').getBoundingClientRect();const detached=[...document.querySelectorAll('.core-connectors circle')].filter((_,i)=>i%2).some(dot=>{const x=svg.left+Number(dot.getAttribute('cx')),y=svg.top+Number(dot.getAttribute('cy'));return Math.abs(Math.hypot((x-lens.left-lens.width/2)/(lens.width/2),(y-lens.top-lens.height/2)/(lens.height/2))-1)>.015;});
          const clipped=[...dashboard.querySelectorAll('.category-card,.core-lens,.home-banner')].filter(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2).map(e=>e.className);
          return {ok:content.scrollHeight<=content.clientHeight+1&&content.scrollWidth<=content.clientWidth+1&&document.documentElement.scrollHeight<=innerHeight+1&&!outside.length&&!clipped.length&&!detached,detached,contentHeight:content.clientHeight,scrollHeight:content.scrollHeight,outside,clipped};
        })()`);
        assert(fit.ok, `Home must fit without scrolling at ${width}x${height} (${lang}): ${JSON.stringify(fit)}`);
        await screenshot(`home-fit-${lang}-${width}x${height}`);
      }
    }
    await evaluate("window.CrotI18n.setLanguage('ru')");
    await size(390, 844);
    await screenshot("home-composition-390");
    await evaluate("document.querySelector('.content').scrollTop=700");
    assert(
      await evaluate("document.querySelector('.content').scrollTop>0"),
      "Mobile Home cannot scroll to lower cards",
    );
    await screenshot("home-mobile-middle");
    await evaluate("document.querySelector('.content').scrollTop=100000");
    assert(
      await evaluate(
        "(()=>{const r=document.querySelector('.home-status-action').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()",
      ),
      "Mobile Home bottom actions are unreachable",
    );
    await screenshot("home-mobile-bottom");
    await evaluate("document.querySelector('.content').scrollTop=0");
    await evaluate("fixture.connection='disconnected';render(fixture)");
    assert(await evaluate("!document.querySelector('#nav-chat .chat-live')"), "Offline bridge falsely marked Live");
    await size(1280, 900);
    await screenshot("home-offline");
    await evaluate("document.querySelector('.home-status-action').click()");
    await screenshot("home-expanded-health");
    assert(
      await evaluate(
        "document.getElementById('action-dialog').open&&document.querySelector('.home-status-dialog .home-health')",
      ),
      "Home connection status dialog missing",
    );
    await evaluate("document.getElementById('action-dialog').close()");
    await evaluate("document.documentElement.dataset.theme='dark'");
    await delay(250);
    assert(
      await evaluate(
        "(()=>{const s=getComputedStyle(document.getElementById('notifications'));return s.color!==s.backgroundColor;})()",
      ),
      "Dark Home notification control lacks contrast",
    );
    await screenshot("home-dark");
    await evaluate("document.documentElement.dataset.theme='light'");
    await delay(250);
    await evaluate("fixture.connection='connected';render(fixture);window.CrotI18n.setLanguage('en')");
    await size(1280, 820);
    await click("nav-agents");
    assert(
      await evaluate(
        "!document.querySelector('[data-integration]')&&(v=>!v||/^https:\\/\\/crot\\.network\\/d\\/[a-z2-7]{26}\\/mcp$/.test(v))(document.querySelector('[data-relay-url]').value)",
      ),
      "Unpaired MCP view fabricated an integration or URL",
    );
    assert(
      await evaluate(
        "[...document.querySelectorAll('.agents-center .agents-description')].some(n=>n.textContent.includes('Custom MCP')&&n.textContent.includes('Bearer Token'))&&!document.querySelector('.agents-center').textContent.includes('OAuth 2.1')",
      ),
      "Remote MCP connection instructions missing",
    );
    await click("nav-home");
    await evaluate(
      "fixture.cards=[{requestId:'test-approval',title:'Write project file',banners:['OUTSIDE THE WORKSPACE'],rows:[{label:'Path',value:'/workspace/evil[U+202E]txt.exe',marks:['outside workspace'],length:32}],expiresAt:'2026-10-22T05:00:00Z'}];render(fixture)",
    );
    await click("notifications");
    await screenshot("approval-request");
    await evaluate(
      "window.approvalButton=document.querySelector('#approvals button');approvalButton.focus();render(fixture);render(fixture)",
    );
    assert(
      await evaluate(
        "approvalButton===document.querySelector('#approvals button')&&document.activeElement===approvalButton",
      ),
      "polling replaced approval focus",
    );
    await evaluate("document.querySelector('#approvals button').click()");
    assert(await evaluate("actions.some(a=>a[0]==='test-approval'&&a[1]==='approve')"), "approval not delegated");
    await evaluate("document.getElementById('action-dialog').close()");
    await route("Settings");
    await evaluate("document.querySelector('[data-setting=Security]').click()");
    await evaluate(
      "[...document.querySelectorAll('#page button')].find(b=>b.textContent==='Enable Full Control').click()",
    );
    assert(
      await evaluate("document.getElementById('action-dialog').open"),
      "dangerous change must require confirmation",
    );
    assert(
      !(await evaluate("actions.some(a=>a[0]==='remote.setFullControl')")),
      "dangerous change dispatched before confirmation",
    );
    await evaluate("[...document.querySelectorAll('#action-dialog button')].find(b=>b.textContent==='Cancel').click()");
    await click("nav-home");
    await size(960, 640);
    await screenshot("home-minimum-desktop");
    assert(
      await evaluate(
        "document.documentElement.scrollHeight<=document.documentElement.clientHeight&&document.querySelectorAll('#navigation>[data-section]').length===10",
      ),
      "minimum desktop viewport failed",
    );
    await route("Browser");
    await screenshot("browser-minimum-desktop");
    await size(1280, 820);
    for (const [name, pathname] of [
      ["welcome", "/welcome"],
      ["portal", "/portal"],
      ["extension-welcome", "/extension/welcome.html"],
    ]) {
      await size(1280, 960);
      await navigate(pathname);
      if (name === "extension-welcome")
        assert(
          await evaluate(
            "['rgb(255, 255, 255)','rgb(20, 20, 18)'].includes(getComputedStyle(document.body).backgroundColor)&&!document.getElementById('status-dot').classList.contains('checking')",
          ),
          name + " must load its external stylesheet and script under CSP",
        );
      else
        assert(
          await evaluate("getComputedStyle(document.documentElement).backgroundColor === 'rgb(9, 9, 11)'"),
          name + " must render the shipped Zinc theme under CSP",
        );
      await screenshot(name);
      for (const language of ["ru", "es", "de", "zh", "en"]) {
        await evaluate(`window.CrotI18n.setLanguage(${JSON.stringify(language)})`);
        assert(
          await evaluate(`document.documentElement.lang===${JSON.stringify(language)}`),
          "language not applied: " + language,
        );
      }
      if (name === "extension-welcome") {
        await click("open-app");
        await click("refresh-status");
        assert(
          await evaluate("actions.some(a=>a[0]==='extension'&&a[1]==='crot.ui.openApp')"),
          "welcome did not open native app",
        );
        await evaluate("document.querySelector('a[href=\\'https://crot.network/account\\']').click()");
        assert(
          await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://crot.network/account')"),
          "welcome account link must open in a browser tab",
        );
      }
      await size(390, 844);
      await screenshot(name + "-mobile");
    }
    const attachment = await globalThis.fetch(origin + "/download/linux");
    assert(
      attachment.status === 200 && attachment.headers.get("content-disposition").includes("attachment"),
      "download endpoint must return an installer attachment",
    );
    const installer = await attachment.text();
    assert(
      installer.includes("/download/bundle/linux") && installer.includes("checksum mismatch"),
      "bootstrap must verify a real release bundle",
    );
    await size(380, 520);
    await navigate("/extension/popup.html");
    await until("document.getElementById('connection').textContent === 'Desktop App Not Detected'");
    assert(
      await evaluate(
        "[document.documentElement,document.body].every(e=>e.getBoundingClientRect().width===380&&e.getBoundingClientRect().height===520)",
      ),
      "popup geometry differs from 380x520",
    );
    await evaluate("window.popupNode=document.getElementById('connection')");
    await click("refresh");
    await delay(100);
    assert(
      await evaluate(
        "popupNode===document.getElementById('connection')&&document.body.getBoundingClientRect().height===520",
      ),
      "popup refresh replaced skeleton or size",
    );
    for (const id of ["open-app", "account", "download", "guide"]) await click(id);
    await delay(100);
    assert(
      await evaluate("actions.some(a=>a[0]==='extension'&&a[1]==='crot.ui.openApp')"),
      "popup native app action missing",
    );
    assert(
      await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://relay-staging.crot.network/portal')"),
      "popup account target missing",
    );
    assert(
      await evaluate("actions.some(a=>a[0]==='tab'&&a[1]==='https://crot.network/#download')"),
      "Install CROT Desktop must open the product download page",
    );
    await screenshot("popup");
    await evaluate("window.CrotI18n.setLanguage('ru')");
    assert(
      await evaluate("document.getElementById('open-app').textContent==='Открыть приложение CROT'"),
      "Russian popup action missing",
    );
    await screenshot("popup-ru");
    await evaluate("window.CrotI18n.setLanguage('en')");
    assert(runtimeErrors.length === 0, "browser exceptions: " + runtimeErrors.join(", "));
    await writeFile(
      path.join(artifacts, "verification.json"),
      JSON.stringify(
        {
          status: "passed",
          scope:
            "real Chromium rendering with owner IPC and extension status fixtures; not live provider or native installer qualification",
        },
        null,
        2,
      ),
    );
  }
} finally {
  await real?.close();
  await authentication.close();
  socket?.close();
  if (browser && browser.exitCode === null) {
    const done = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await done;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
