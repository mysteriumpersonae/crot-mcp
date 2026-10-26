import { Script } from "node:vm";
import { it, expect } from "vitest";
import { CONTROL_CENTER_RENDERER } from "../../src/tray/control-center-renderer.js";
it("compiles the shipped renderer and exposes real Stage B RPC controls", () => {
  expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
  for (const name of [
    "projects.syncWorkspaceArtifacts",
    "skills.create",
    "skills.test",
    "browser.policy.set",
    "system.check",
    "chat.testConnection",
    "onboarding.advance",
  ])
    expect(CONTROL_CENTER_RENDERER).toContain(name);
});

it("shipped publication review uses only immutable owner previews and requires an explicit human click", () => {
  for (const method of [
    "publications.open",
    "publications.preview",
    "publications.confirm",
    "publications.cancel",
    "accounts.avatar",
  ])
    expect(CONTROL_CENTER_RENDERER).toContain(method);
  expect(CONTROL_CENTER_RENDERER).toContain("privacy.value=''");
  expect(CONTROL_CENTER_RENDERER).toContain("crypto.subtle.digest('SHA-256'");
  expect(CONTROL_CENTER_RENDERER).toContain("publish.onclick=async()=>");
  expect(CONTROL_CENTER_RENDERER).not.toContain("image.src=record.avatar");
});
