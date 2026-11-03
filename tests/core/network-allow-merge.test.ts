/**
 * Sandbox network default is deny-all (Option A). AI provider hosts are never baked into the
 * core config; ProductRuntime adds them dynamically (core.addNetworkAllow) for saved providers.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/core/config/load.js";

describe("parseConfig — network.allow defaults", () => {
  it("new project with no permissions key gets an empty allow list", () => {
    const config = parseConfig({ workspace: { root: "/tmp" } });
    expect(config.permissions.network).toEqual({ allow: [], deny: [] });
  });

  it("does not merge provider hosts into an existing empty allow list", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: [], deny: [] } },
    });
    expect(config.permissions.network.allow).toEqual([]);
  });

  it("preserves exactly the owner's saved hosts", () => {
    const config = parseConfig({
      workspace: { root: "/tmp" },
      permissions: { network: { allow: ["my-llm.example.com"], deny: [] } },
    });
    expect(config.permissions.network.allow).toEqual(["my-llm.example.com"]);
    expect(config.permissions.network.allow).not.toContain("api.river.ai");
  });
});
