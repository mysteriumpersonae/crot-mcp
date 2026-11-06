/**
 * Service worker of the CROT Browser Extension (Manifest V3, Chromium:
 * Chrome, Edge, Brave).
 *
 * The extension is the browser end of CROT's browser bridge. It connects to
 * the CROT Host through native messaging (or, when the browser has no native
 * host, the paired loopback channel to CROT Desktop, loopback.ts) and executes the fixed set of
 * browser commands the host sends; the host only sends commands that Core's
 * PermissionEngine has authorized. The popup reports connection state; the bridge takes no tool action
 * on its own and runs no code in pages other than the fixed functions in
 * page-functions.ts.
 *
 * Event listeners are registered synchronously at startup, as Manifest V3
 * requires for a suspended service worker to be woken by them.
 */
import { detectBrowser } from "./browser-info.js";
import { CdpSessions } from "./cdp.js";
import { createCommandHandlers } from "./commands.js";
import { ownerUiAction, ownerUiPairInstance } from "./owner-ui.js";
import { HostConnection } from "./host-connection.js";
import { LoopbackLink, type LoopbackSocket } from "./loopback.js";

/** Wakes the service worker to reconnect while CROT is not reachable. 30 s is the shortest period Chrome allows. */
const RECONNECT_ALARM = "crot-reconnect";

/** ControlOrMeta of browser_press_key and click modifiers is Meta on macOS. */
const platform =
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
const mac = /mac/i.test(platform);

/** Debugger sessions (Browser v1, AD-16 point 3); detached when the CROT connection ends. */
const cdp = new CdpSessions(chrome, { onNotice: (notice) => connection.notify(notice) });

const browser = detectBrowser(navigator, chrome.runtime.getManifest().version);
const log = (message: string) => console.info("CROT: " + message);
const extensionId = chrome.runtime.id ?? "";
/** Discovery and pairing with CROT Desktop on 127.0.0.1 when native messaging is unavailable. */
const loopback = extensionId
  ? new LoopbackLink({
      fetch: (url, init) => fetch(url, init),
      socket: (url) => new WebSocket(url) as unknown as LoopbackSocket,
      storage: chrome.storage?.local,
      origin: "chrome-extension://" + extensionId,
      browser,
      log,
    })
  : undefined;

let resetQueues = (): void => undefined;
const connection = new HostConnection({
  runtime: chrome.runtime,
  browser,
  loopback,
  // Fixed owner action from CROT Desktop → Browser: this extension's own page, nothing else.
  onManage: () => {
    if (extensionId)
      void chrome.tabs.create({ url: "chrome://extensions/?id=" + extensionId, active: true }).catch(() => undefined);
  },
  handlers: createCommandHandlers(chrome, {
    cdp,
    mac,
    onQueueReset: (reset) => {
      resetQueues = reset;
    },
  }),
  log,
  onDisconnected: () => {
    resetQueues();
    void cdp.detachAll();
  },
});

// Fixed owner UI channel. Only exact packaged UI pages; never content scripts or browser tools.
const uiRuntime = chrome.runtime as typeof chrome.runtime & {
  getURL?: (path: string) => string;
  onMessage?: {
    addListener(
      listener: (message: unknown, sender: { url?: string }, reply: (value: unknown) => void) => boolean | void,
    ): void;
  };
};
uiRuntime.onMessage?.addListener((message, sender, reply) => {
  const action = ownerUiAction(message, sender.url, uiRuntime.getURL?.(""));
  if (!action) return;
  if (action === "open") {
    void connection.openControlCenter().then((ok) => reply({ ok }));
    return true;
  }
  if (action === "pair") {
    loopback?.pair(ownerUiPairInstance(message));
    connection.ensureConnected();
    reply({ ok: loopback !== undefined });
    return;
  }
  // An open popup or welcome page looks for CROT Desktop right away instead of waiting for the backoff.
  connection.ensureConnected();
  reply({ connection: connection.state, transport: connection.transport, link: loopback?.view });
});

// Content-free hints so CROT Desktop refreshes its tab list (no tab data is sent with them).
const tabsChanged = () => connection.tabsChanged();
chrome.tabs.onCreated.addListener(tabsChanged);
chrome.tabs.onRemoved.addListener(tabsChanged);
chrome.tabs.onActivated?.addListener(tabsChanged);
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url !== undefined || change.title !== undefined || change.status === "complete") tabsChanged();
});

chrome.runtime.onStartup.addListener(() => connection.ensureConnected());
chrome.runtime.onInstalled.addListener((details?: { reason?: string }) => {
  connection.ensureConnected();
  if (details?.reason === "install") {
    const welcome = uiRuntime.getURL?.("welcome.html");
    if (welcome) void chrome.tabs.create({ url: welcome, active: true }).catch(() => undefined);
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connection.ensureConnected();
});
void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
connection.ensureConnected();
