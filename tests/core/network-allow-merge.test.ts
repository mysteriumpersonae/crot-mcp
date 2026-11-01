/**
 * Regression test: existing projects with empty network.allow must still
 * reach AI providers after parseConfig (hotfix for NETWORK_GUARD_BLOCKED, PR #51).
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/core/config/load.js";
import { DEFAULT_AI_NETWORK_ALLOW } from "../../src/core/config/schema.js";

describe("parseConfig — DEFAULT_AI_NETWORK_ALLOW migration", () => {
  it("merges DEFAULT_AI_NETWORK_ALLOW into an existing empty allow list", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: [], deny: [] } },
    });
    for (const host of DEFAULT_AI_NETWORK_ALLOW) {
      expect(config.permissions.network.allow).toContain(host);
    }
  });

  it("includes api.river.ai so chat.configure with River does not return NETWORK_GUARD_BLOCKED", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: [], deny: [] } },
    });
    expect(config.permissions.network.allow).toContain("api.river.ai");
  });

  it("does not duplicate hosts that are already in the saved allow list", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: ["api.openai.com", "api.river.ai"], deny: [] } },
    });
    const count = (host: string) => config.permissions.network.allow.filter((h) => h === host).length;
    expect(count("api.openai.com")).toBe(1);
    expect(count("api.river.ai")).toBe(1);
  });

  it("preserves custom user-defined hosts alongside the defaults", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: ["my-llm.example.com"], deny: [] } },
    });
    expect(config.permissions.network.allow).toContain("my-llm.example.com");
    expect(config.permissions.network.allow).toContain("api.openai.com");
    expect(config.permissions.network.allow).toContain("api.river.ai");
  });

  it("new project with no permissions key gets defaults (unchanged behaviour)", () => {
    const config = parseConfig({ workspace: { root: "/tmp" } });
    expect(config.permissions.network.allow).toContain("api.river.ai");
    expect(config.permissions.network.allow).toContain("api.openai.com");
  });
});
