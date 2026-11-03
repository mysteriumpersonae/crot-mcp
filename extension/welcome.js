/* global chrome, document, localStorage, navigator, setTimeout, window */
"use strict";
const html = document.documentElement;
const byId = (id) => document.getElementById(id);
const feedback = (text, clearAfterMs) => {
  const node = byId("feedback");
  node.textContent = text;
  if (clearAfterMs)
    setTimeout(() => {
      if (node.textContent === text) node.textContent = "";
    }, clearAfterMs);
};

// Theme
const themeToggle = byId("theme-toggle");
const applyTheme = (theme) => {
  html.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
};
let storedTheme = null;
try {
  storedTheme = localStorage.getItem("crot-theme");
} catch {
  storedTheme = null;
}
applyTheme(
  storedTheme === "dark" || storedTheme === "light"
    ? storedTheme
    : window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
);
themeToggle.addEventListener("click", () => {
  const next = html.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("crot-theme", next);
  } catch {
    // Storage may be unavailable; the theme still applies for this page.
  }
});

// All external navigation happens in a browser tab, never under chrome-extension://.
for (const link of document.querySelectorAll("a[href^='https://']"))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.tabs
      .create({ url: link.href, active: true })
      .catch(() => feedback("Не удалось открыть ссылку. Попробуйте ещё раз."));
  });

// Desktop connection status
const dot = byId("status-dot");
const label = byId("status-label");
const refreshButton = byId("refresh-status");
const setStatus = (state, text) => {
  dot.className = "status-dot " + state;
  label.textContent = text;
};
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
async function checkConnection() {
  refreshButton.disabled = true;
  setStatus("checking", "Проверка подключения к десктопу…");
  try {
    const state = await withTimeout(chrome.runtime.sendMessage({ type: "crot.ui.status" }), 3000);
    if (state?.connection === "connected") setStatus("connected", "✓ Десктоп подключён — CROT готов к работе");
    else setStatus("disconnected", "✗ Десктоп не подключён — запустите CROT App");
  } catch {
    setStatus("disconnected", "✗ Десктоп не подключён — запустите CROT App");
  } finally {
    refreshButton.disabled = false;
  }
}
refreshButton.addEventListener("click", () => void checkConnection());

// Open the desktop app
async function openApp() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "crot.ui.openApp" });
    feedback(result?.ok ? "CROT App открывается…" : "Не удалось открыть — убедитесь, что CROT запущен.");
  } catch {
    feedback("Не удалось открыть — установите и запустите CROT App.");
  }
}
byId("open-app").addEventListener("click", () => void openApp());
byId("open-app-2").addEventListener("click", () => void openApp());

// Copy launch command
byId("copy-cmd").addEventListener("click", async () => {
  const cmd = "npx crot-mcp";
  try {
    await navigator.clipboard.writeText(cmd);
    feedback("✓ Команда скопирована: " + cmd, 3000);
  } catch {
    feedback("Копирование недоступно. Скопируйте команду вручную: " + cmd, 3000);
  }
});

void checkConnection();
