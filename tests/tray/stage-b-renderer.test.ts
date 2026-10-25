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
