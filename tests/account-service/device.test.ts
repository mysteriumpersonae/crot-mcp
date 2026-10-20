import { expect, it, vi } from "vitest";
import { AccountService } from "../../src/account-service/service.js";
import { DeviceIdentity } from "../../src/service/identity.js";
import { createIdentityHttp } from "../../src/identity/http.js";
import { RelayHarness } from "../cloud-relay/harness.js";
import { openBinding, testEnvironment } from "../identity/helpers.js";
import { makeTempDirs } from "../helpers.js";
import { MCP_CLIENT } from "../identity/test-authorization-server.js";
it("device identity signs status/provider requests, caches metadata only and reports cloud failure without secrets", async () => {
  const dirs = await makeTempDirs();
  const accounts = await AccountService.open();
  await accounts.startTrial("user_01");
  const provider = { revoke: vi.fn(async () => "requested" as const) };
  const h = await new RelayHarness().start({ accounts, registry: accounts, provider });
  try {
    const environment = testEnvironment();
    const { binding, deviceId } = await openBinding(dirs.outside, { environment });
    const credential = binding.tunnelCredential(environment);
    if (!credential.ok) throw new Error("missing test credential");
    expect(
      (
        await h.registerRaw(
          deviceId,
          h.as.token({
            resource: `https://${environment.relayHost}/d/${deviceId}/mcp`,
            sub: "user_01",
            clientId: environment.pairing.clientId,
          }),
          { publicKey: credential.credential.publicKey },
        )
      ).status,
    ).toBe(201);
    let offline = false;
    let now = Date.now();
    const sent: string[] = [];
    const http = createIdentityHttp({
      fetch: (async (input, init) => {
        if (offline) throw new Error("cloud unavailable");
        const url = new URL(String(input));
        sent.push(JSON.stringify(init));
        if (url.host === environment.relayHost) return fetch(h.origin + url.pathname, init);
        return h.as.fetch(input, init);
      }) as typeof fetch,
    });
    const identity = new DeviceIdentity({ environment, binding, http, log: () => undefined, now: () => now });
    await identity.refreshCommercialStatus();
    expect(identity.commercialStatus).toMatchObject({ plan: "trial", entitled: true, maxDevices: 2, deviceCount: 1 });
    const requests = sent.length;
    await identity.refreshCommercialStatus();
    expect(sent).toHaveLength(requests);
    await accounts.noteClient("user_01", deviceId, MCP_CLIENT);
    expect(await identity.revokeAtProvider({ accountId: "user_01", deviceId, clientId: MCP_CLIENT })).toBe("requested");
    expect(provider.revoke).toHaveBeenCalledWith("user_01", MCP_CLIENT);
    expect(await identity.revokeAtProvider({ accountId: "other", deviceId, clientId: MCP_CLIENT })).toBe(
      "not_available",
    );
    offline = true;
    now += 31_000;
    await identity.refreshCommercialStatus();
    expect(identity.commercialStatus).toBeUndefined();
    expect(await identity.revokeAtProvider({ accountId: "user_01", deviceId, clientId: MCP_CLIENT })).toBe("failed");
    expect(sent.join("\n")).not.toContain("Bearer");
    expect(sent.join("\n")).not.toContain(dirs.workspace);
  } finally {
    await h.stop();
    await dirs.cleanup();
  }
});
