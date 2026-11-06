/* global chrome, document, URL, window, setTimeout, clearTimeout */
"use strict";
const byId = (id) => document.getElementById(id);
const FALLBACK_PORTAL = "https://relay-staging.crot.network/portal";
/** Scenario B: the extension came first; CROT Desktop is downloaded from the product site. */
const DESKTOP_DOWNLOAD = "https://crot.network/#download";
/** While the popup is open and CROT is not connected, the status is refreshed (and CROT searched) this often. */
const POLL_MS = 2000;
let portal = FALLBACK_PORTAL;
let pollTimer;
function destination(path) {
  const url = new URL(portal);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.href;
}
async function openTab(url) {
  await chrome.tabs.create({ url, active: true });
}
async function run(action) {
  try {
    await action();
  } catch {
    byId("error").textContent = "Action failed. Check the desktop service and try again.";
  }
}
/** Show errors without initiating an independent connection. */
function renderLink(link) {
  byId("install-note").textContent =
    link?.state === "error" && typeof link.message === "string"
      ? link.message
      : "Install and start CROT Desktop. The extension connects automatically.";
  return link?.state === "searching" ? "Looking for CROT Desktop…" : "Desktop App Not Detected";
}
async function refreshStatus() {
  clearTimeout(pollTimer);
  const refresh = byId("refresh");
  refresh.disabled = true;
  byId("error").textContent = "";
  let connected = false;
  try {
    let state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    for (let attempt = 0; state?.connection === "connecting" && attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await chrome.runtime.sendMessage({ type: "crot.ui.status" });
    }
    connected = state?.connection === "connected";
    if (typeof state?.portalUrl === "string") {
      const url = new URL(state.portalUrl);
      if (url.protocol === "https:" && !url.username && !url.password) portal = url.href;
    }
    byId("connection").textContent = connected
      ? "Connected to CROT"
      : state?.connection === "connecting"
        ? "Connecting…"
        : renderLink(state?.link);
    byId("connection").className = "badge " + (connected ? "ready" : "warning");
    byId("install").hidden = connected;
  } catch {
    byId("connection").textContent = renderLink(undefined);
    byId("install").hidden = false;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    byId("tab").textContent = tab
      ? "Active tab: " + (tab.status === "complete" ? "loaded" : "loading")
      : "No active tab";
    const groups = tab ? await chrome.tabGroups.query({ title: "CROT", windowId: tab.windowId }) : [];
    byId("group").textContent = groups.some((g) => g.id === tab.groupId)
      ? "Active tab is in the CROT group"
      : groups.length
        ? "CROT group is ready in this window"
        : "No CROT group in this window";
  } catch {
    byId("tab").textContent = "Tab status is unavailable";
  } finally {
    refresh.disabled = false;
    window.CrotI18n?.apply();
  }
  pollTimer = setTimeout(() => void refreshStatus(), POLL_MS);
}
byId("refresh").addEventListener("click", () => void refreshStatus());
byId("open-app").addEventListener(
  "click",
  () =>
    void run(async () => {
      const result = await chrome.runtime.sendMessage({ type: "crot.ui.openApp" });
      if (!result?.ok) {
        byId("install").hidden = false;
        byId("error").textContent = "Start CROT Desktop, then refresh the connection.";
      }
    }),
);
byId("account").addEventListener("click", () => void run(() => openTab(destination("/portal"))));
byId("download").addEventListener("click", () => void run(() => openTab(DESKTOP_DOWNLOAD)));
byId("guide").addEventListener("click", () => void run(() => openTab(chrome.runtime.getURL("welcome.html"))));
void refreshStatus();
