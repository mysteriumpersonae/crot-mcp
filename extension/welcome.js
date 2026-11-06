/* global chrome, clearTimeout, document, localStorage, navigator, setTimeout, window */
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

// Desktop connection status. Scenario B: the extension came first; while CROT Desktop is not
// connected the page keeps asking the background worker, which searches CROT on its own.
const dot = byId("status-dot");
const label = byId("status-label");
const refreshButton = byId("refresh-status");
const install = byId("install-desktop");
const openButton = byId("open-app");
const tag = byId("hero-tag-label");
const POLL_MS = 3000;
let pollTimer;
const setStatus = (state, text) => {
  dot.className = "status-dot " + state;
  label.textContent = text;
};
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
const ERRORS = {
  "Connection to CROT Desktop failed": "Не удалось подключиться к CROT Desktop",
  "The program on the CROT port could not prove it is your CROT Desktop":
    "Программа на порту CROT не смогла подтвердить, что это ваш CROT Desktop",
  "CROT Desktop did not accept the connection": "CROT Desktop не принял подключение",
  "Too many connection requests. Try again in a few minutes.":
    "Слишком много запросов на подключение. Повторите через несколько минут.",
  "CROT Desktop did not accept the connection request": "CROT Desktop не принял запрос на подключение",
};
function showLink(link) {
  if (link?.state === "error" && typeof link.message === "string")
    return ["disconnected", "✗ " + (ERRORS[link.message] || "Не удалось подключиться к CROT Desktop")];
  return [
    "disconnected",
    "✗ CROT Desktop не найден — установите и запустите приложение, расширение подключится автоматически",
  ];
}
async function checkConnection(manual) {
  clearTimeout(pollTimer);
  if (manual) {
    refreshButton.disabled = true;
    setStatus("checking", "Проверка подключения к десктопу…");
  }
  let connected = false;
  try {
    let state = await withTimeout(chrome.runtime.sendMessage({ type: "crot.ui.status" }), 3000);
    for (let attempt = 0; state?.connection === "connecting" && attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await withTimeout(chrome.runtime.sendMessage({ type: "crot.ui.status" }), 3000);
    }
    connected = state?.connection === "connected";
    if (connected) {
      showLink(undefined);
      setStatus("connected", "✓ Подключено к CROT");
    } else {
      const [kind, text] = showLink(state?.link);
      setStatus(kind, text);
    }
  } catch {
    const [kind, text] = showLink(undefined);
    setStatus(kind, text);
  } finally {
    refreshButton.disabled = false;
  }
  install.hidden = connected;
  openButton.className = "btn btn-lg " + (connected ? "btn-primary" : "btn-ghost");
  tag.textContent = connected ? "Расширение установлено · CROT Ready" : "Расширение установлено · подключите десктоп";
  pollTimer = setTimeout(() => void checkConnection(false), POLL_MS);
}
refreshButton.addEventListener("click", () => void checkConnection(true));

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

void checkConnection(true);
