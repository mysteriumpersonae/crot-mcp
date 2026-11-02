/**
 * Local bearer token path: unpaired device with a local token verifier.
 *
 * Tests the extension added in feat/relay-local-device-token that lets an
 * unpaired device's requests pass through the relay using a locally-validated
 * bearer token instead of a cloud OAuth JWT. The relay forwards the request
 * to the local MCP HTTP server via `localMcpUrl`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CloudRelay } from "../../src/cloud-relay/server.js";
import { MemoryDeviceRegistry } from "../../src/cloud-relay/registry.js";
import { generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { TEST_RELAY, TestAuthorizationServer } from "../identity/test-authorization-server.js";

const VALID_TOKEN = "crot_local_test_token_valid";
const INVALID_TOKEN = "crot_local_test_token_bad";

async function fetch200(url: string, options: RequestInit): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const body = await res.text();
  return { status: res.status, body };
}

describe("Relay local bearer token path (WP-30 extension)", () => {
  let relay: CloudRelay;
  let mockMcpServer: ReturnType<typeof createServer>;
  let mockMcpPort: number;
  let relayOrigin: string;
  let localDeviceId: string;
  const as = new TestAuthorizationServer();
  const registry = new MemoryDeviceRegistry();

  beforeEach(async () => {
    localDeviceId = generateDeviceId();

    // Minimal mock local MCP HTTP server
    mockMcpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const body: Buffer[] = [];
      req.on("data", (c: Buffer) => body.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "crot", version: "test" } } }));
      });
    });
    await new Promise<void>((resolve) => mockMcpServer.listen(0, "127.0.0.1", resolve));
    mockMcpPort = (mockMcpServer.address() as { port: number }).port;

    relay = new CloudRelay({
      relayHost: TEST_RELAY,
      issuer: as.issuer,
      pairingClientId: "pairing_client",
      environment: "test",
      keys: new IssuerKeySet({ issuer: as.issuer, http: as.http() }),
      registry,
      entitlement: () => "entitled" as const,
      // Local bearer extension
      localDeviceId,
      localTokenVerifier: (token) => token === VALID_TOKEN,
      localMcpUrl: `http://127.0.0.1:${mockMcpPort}`,
    });
    await relay.listen({ port: 0, host: "127.0.0.1" });
    relayOrigin = `http://127.0.0.1:${relay.port}`;
  });

  afterEach(async () => {
    await relay.close();
    await new Promise<void>((resolve) => mockMcpServer.close(() => resolve()));
  });

  it("returns 401 with no Authorization header", async () => {
    const { status } = await fetch200(`${relayOrigin}/d/${localDeviceId}/mcp`, { method: "POST" });
    expect(status).toBe(401);
  });

  it("returns 401 with invalid local token", async () => {
    const { status } = await fetch200(`${relayOrigin}/d/${localDeviceId}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INVALID_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(status).toBe(401);
  });

  it("proxies to local MCP server with valid local token → 200", async () => {
    const { status, body } = await fetch200(`${relayOrigin}/d/${localDeviceId}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion", version: "1" } } }),
    });
    expect(status).toBe(200);
    const json = JSON.parse(body) as { result?: { protocolVersion?: string } };
    expect(json.result?.protocolVersion).toBe("2024-11-05");
  });

  it("returns 404 for an unknown (unpaired) device without local config", async () => {
    const otherId = generateDeviceId();
    const { status } = await fetch200(`${relayOrigin}/d/${otherId}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(status).toBe(404);
  });
});

describe("local-device-id service module", () => {
  it("loadOrCreateLocalDeviceId generates and persists a valid base32 device ID", async () => {
    const { loadOrCreateLocalDeviceId } = await import("../../src/service/local-device-id.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { isDeviceId } = await import("../../src/identity/device-id.js");
    const dir = await mkdtemp(tmpdir() + "/crot-local-device-test-");
    try {
      const privateFiles = { ensureDirectory: async () => {}, fileMode: 0o600 };
      const id1 = await loadOrCreateLocalDeviceId(dir, privateFiles as never);
      expect(isDeviceId(id1)).toBe(true);
      // Second call returns the same ID (persisted)
      const id2 = await loadOrCreateLocalDeviceId(dir, privateFiles as never);
      expect(id2).toBe(id1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
