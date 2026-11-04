import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { externalLink } from "../../src/tray/external-links.js";

it("opens only allowlisted HTTPS pages in the browser", () => {
  expect(externalLink("https://opencode.ai/zen")).toBe("https://opencode.ai/zen");
  expect(externalLink("https://opencode.ai/docs/zen/#api-key")).toBe("https://opencode.ai/docs/zen/#api-key");
  for (const url of ["https://notion.so", "https://www.notion.so/x", "https://claude.ai", "https://n8n.io"])
    expect(externalLink(url)).toBe(new URL(url).href);
  for (const url of [
    "http://opencode.ai/zen",
    "https://opencode.ai.evil.example/zen",
    "https://evil.example/?u=https://opencode.ai",
    "https://user:pass@opencode.ai/zen",
    "https://opencode.ai:8443/zen",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "crot://open",
    "not a url",
  ])
    expect(externalLink(url)).toBeUndefined();
});

it("still denies every in-app window and opens allowlisted links outside the app", () => {
  // Windows checkouts may use CRLF; compare the source with normalized line endings.
  const main = readFileSync(new URL("../../src/tray/main.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(main).toContain("contents.setWindowOpenHandler(({ url }) => {");
  expect(main).toContain("const target = smokeReport ? undefined : externalLink(url);");
  expect(main).toContain('if (target) void shell.openExternal(target);\n      return { action: "deny" };');
});
