/**
 * Regression test: OpenAI-compatible providers with a custom endpoint must not
 * return NETWORK_GUARD_BLOCKED after chat.configure is called.
 *
 * When the owner configures a provider endpoint, CrotCore.addNetworkAllow()
 * must be called to allow the endpoint's hostname in the live NetworkPolicy,
 * even if the hostname was not in permissions.network.allow at startup.
 */
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatRuntime, providerNetworkHosts } from "../../src/service/chat-runtime.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import type { NetworkTarget } from "../../src/core/permissions/network/policy.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { ProductRuntime } from "../../src/service/product-runtime.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";

describe("dynamic network allow for custom AI provider endpoints", () => {
  it("addNetworkAllow extends live policy so a custom endpoint is not blocked", async () => {
    const dirs = await makeTempDirs();
    // Start with a minimal allow list that does NOT include the custom endpoint host.
    const core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: {
          mode: "full_control",
          // Intentionally omit the custom host — only allow OpenAI's default host.
          network: { allow: ["api.openai.com"], deny: [] },
        },
      },
      new MemoryAuditSink(),
    );
    try {
      // Before addNetworkAllow: a custom host should be blocked.
      const policyBefore = core.permissions.network.summary();
      expect(policyBefore.allow).not.toContain("custom-llm.example.com");

      // After addNetworkAllow: the host is accessible.
      core.addNetworkAllow(["custom-llm.example.com"]);
      const policyAfter = core.permissions.network.summary();
      expect(policyAfter.allow).toContain("custom-llm.example.com");

      // Idempotent: adding the same host twice does not duplicate.
      core.addNetworkAllow(["custom-llm.example.com"]);
      const count = core.permissions.network.summary().allow.filter((h) => h === "custom-llm.example.com").length;
      expect(count).toBe(1);
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("addNetworkAllow allows the live NetworkPolicy to pass evaluate() for the added host", async () => {
    const dirs = await makeTempDirs();
    const audit = new MemoryAuditSink();
    // Server that returns an empty models list.
    let serverRequests = 0;
    const server = http.createServer((req, res) => {
      serverRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    // Core is created WITHOUT the loopback port in network.allow.
    const core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: {
          mode: "full_control",
          network: { allow: ["api.openai.com"], deny: [] },
        },
      },
      audit,
    );
    try {
      // Add the test server's address via addNetworkAllow.
      core.addNetworkAllow([`127.0.0.1:${port}`]);
      const chat = new ChatRuntime({
        core: () => core,
        context: () => testContext,
        configuration: () => ({ endpoint: `http://127.0.0.1:${port}/v1` }),
        credential: () => "test-key",
        run: (ctx, work) => work(ctx),
      });
      // models() must succeed — i.e. network.request must pass, not return NETWORK_GUARD_BLOCKED.
      const result = await chat.models("OpenAI-compatible");
      expect(result).toMatchObject({ ok: true, models: [] });
      expect(serverRequests).toBeGreaterThan(0);
      await chat.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("explicit runtime deny(network.request) still blocks even after addNetworkAllow", async () => {
    const dirs = await makeTempDirs();
    const audit = new MemoryAuditSink();
    let serverRequests = 0;
    const server = http.createServer((_, res) => {
      serverRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: {
          mode: "full_control",
          network: { allow: [`127.0.0.1:${port}`] },
        },
      },
      audit,
    );
    try {
      // Allow the host but then add a runtime deny rule for network.request.
      core.addNetworkAllow([`127.0.0.1:${port}`]);
      core.permissions.runtime.replace({
        strict: false,
        rules: [{ operation: "network.request", state: "deny" }],
      });
      const chat = new ChatRuntime({
        core: () => core,
        context: () => testContext,
        configuration: () => ({ endpoint: `http://127.0.0.1:${port}/v1` }),
        credential: () => "test-key",
        run: (ctx, work) => work(ctx),
      });
      // Should be blocked by the runtime deny rule — models() throws on permission denial.
      await expect(chat.models("OpenAI-compatible")).rejects.toThrow();
      expect(serverRequests).toBe(0);
      await chat.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await core.shutdown();
      await dirs.cleanup();
    }
  });
});

const allowed = (core: CrotCore, url: string): boolean => {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const target: NetworkTarget = {
    scheme: u.protocol === "https:" ? "https" : "http",
    host,
    hostKind: /^[\d.]+$/.test(host) || host.includes(":") ? "address" : "name",
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
  };
  return core.permissions.network.evaluate(target).allowed;
};

describe("providerNetworkHosts", () => {
  it("keeps non-default ports and preset hosts", () => {
    expect(providerNetworkHosts("OpenAI")).toEqual(["api.openai.com"]);
    expect(providerNetworkHosts("OpenAI-compatible", "https://api.river.ai/v1")).toEqual(["api.river.ai"]);
    expect(providerNetworkHosts("OpenAI-compatible", "https://llm.example.com:8443/v1")).toEqual([
      "llm.example.com:8443",
    ]);
    expect(providerNetworkHosts("Local HTTP", "http://127.0.0.1:11434/v1")).toContain("127.0.0.1:11434");
    expect(providerNetworkHosts("Local HTTP")).toContain("127.0.0.1:1234");
    expect(providerNetworkHosts("Custom API", "not a url")).toEqual([]);
  });
});

describe("ProductRuntime with the default network.allow: []", () => {
  async function setup() {
    const dirs = await makeTempDirs();
    const stateDir = path.join(dirs.outside, "state");
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    // No permissions.network → schema default { allow: [], deny: [] }.
    const newCore = () =>
      createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    const open = (core: CrotCore) =>
      ProductRuntime.open({
        stateDir,
        privateFiles,
        secrets: store,
        core: () => core,
        selectWorkspace: async () => {},
        recordControlEvent: async () => {},
      });
    return { dirs, newCore, open };
  }

  it("allows preset and custom providers on chat.configure and again after restart", async () => {
    const { dirs, newCore, open } = await setup();
    const presets: [string, string][] = [
      ["OpenAI", "https://api.openai.com/v1/models"],
      ["Anthropic", "https://api.anthropic.com/v1/models"],
      ["Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"],
      ["OpenRouter", "https://openrouter.ai/api/v1/models"],
      ["OpenCode (Free & Zen)", "https://opencode.ai/zen/v1/models"],
      ["OpenCode", "http://127.0.0.1:4096/session"],
    ];
    let core = await newCore();
    let runtime: ProductRuntime | undefined;
    try {
      expect(core.permissions.network.summary().allow).toEqual([]);
      expect(allowed(core, "https://api.openai.com/v1/models")).toBe(false);
      runtime = await open(core);
      for (const [provider] of presets) await runtime.request("chat.configure", { provider });
      await runtime.request("chat.configure", { provider: "Local HTTP", endpoint: "http://127.0.0.1:11434/v1" });
      await runtime.request("chat.configure", {
        provider: "OpenAI-compatible",
        endpoint: "https://api.river.ai/v1",
        credential: "test-key",
      });
      const expectAllAllowed = (c: CrotCore) => {
        for (const [, url] of presets) expect(allowed(c, url), url).toBe(true);
        expect(allowed(c, "http://127.0.0.1:11434/v1/models")).toBe(true);
        expect(allowed(c, "https://api.river.ai/v1/models")).toBe(true);
        // Unrelated hosts stay blocked: the default remains deny-by-default.
        expect(allowed(c, "https://unrelated.example.com/")).toBe(false);
      };
      expectAllAllowed(core);
      await runtime.close();
      runtime = undefined;
      await core.shutdown();
      // Restart: a fresh core starts with allow: [] and ProductRuntime.open restores the saved providers.
      core = await newCore();
      expect(core.permissions.network.summary().allow).toEqual([]);
      runtime = await open(core);
      expectAllAllowed(core);
    } finally {
      await runtime?.close();
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("connects a custom OpenAI-compatible endpoint without NETWORK_GUARD_BLOCKED", async () => {
    const { dirs, newCore, open } = await setup();
    const server = http.createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "river-1" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const core = await newCore();
    let runtime: ProductRuntime | undefined;
    try {
      runtime = await open(core);
      const endpoint = `http://127.0.0.1:${port}/v1`;
      const saved = await runtime.request("chat.configure", {
        provider: "OpenAI-compatible",
        endpoint,
        credential: "k",
      });
      const key = `OpenAI-compatible:127-0-0-1-${port}`;
      expect(saved.provider).toBe(key);
      expect(allowed(core, endpoint + "/models")).toBe(true);
      const result = await runtime.request("chat.testConnection", { provider: key });
      expect(result).toMatchObject({ ok: true, models: ["river-1"] });
      const listed = (await runtime.request("chat.providers", {})).providers as {
        provider: string;
        connectionStatus?: string;
        connectionError?: unknown;
      }[];
      const custom = listed.find((p) => p.provider === key);
      expect(custom).toMatchObject({ connectionStatus: "connected" });
      expect(custom?.connectionError).toBeUndefined();
    } finally {
      await runtime?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await core.shutdown();
      await dirs.cleanup();
    }
  });
});
