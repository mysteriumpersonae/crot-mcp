/**
 * Regression test: OpenAI-compatible providers with a custom endpoint must not
 * return NETWORK_GUARD_BLOCKED after chat.configure is called.
 *
 * When the owner configures a provider endpoint, CrotCore.addNetworkAllow()
 * must be called to allow the endpoint's hostname in the live NetworkPolicy,
 * even if the hostname was not in permissions.network.allow at startup.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { ChatRuntime } from "../../src/service/chat-runtime.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { createTestCore, makeTempDirs, testContext, waitFor } from "../helpers.js";

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
