import { afterEach, describe, expect, it } from "vitest";
import { parseRelayConfig, selfRegistrationFromEnv } from "../../src/cloud-relay/config.js";
import { RelayHarness } from "./harness.js";

let h: RelayHarness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe("device routes are dispatched before downloads and public pages", () => {
  it("never answers POST /d/<id>/mcp or /d/<id>/self-register with the downloads 405", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    for (const action of ["mcp", "self-register"]) {
      const response = await fetch(`${h.origin}/d/${device.deviceId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await response.text();
      expect(response.status).not.toBe(405);
      expect(response.headers.get("allow")).not.toBe("GET, HEAD");
    }
  });

  it("answers malformed device paths with a plain 404", async () => {
    h = await new RelayHarness().start();
    for (const pathname of ["/d/test/mcp", "/d/test/self-register", "/d/test"]) {
      const response = await fetch(h.origin + pathname, { method: "POST", body: "{}" });
      await response.text();
      expect(response.status).toBe(404);
      expect(response.headers.get("allow")).toBeNull();
    }
  });
});

describe("CROT_RELAY_SELF_REGISTRATION", () => {
  const base = {
    relayHost: "relay.crot.example",
    issuer: "https://auth.crot.example",
    registryFile: "/var/lib/crot/devices.json",
    pairingClientId: "client_pairing_native",
  };
  it("enables self-registration from the environment without a config change", () => {
    expect(selfRegistrationFromEnv({ CROT_RELAY_SELF_REGISTRATION: "1" })).toBe(true);
    expect(selfRegistrationFromEnv({ CROT_RELAY_SELF_REGISTRATION: "true" })).toBe(true);
    expect(selfRegistrationFromEnv({ CROT_RELAY_SELF_REGISTRATION: "0" })).toBe(false);
    expect(selfRegistrationFromEnv({})).toBe(false);
    expect(parseRelayConfig(base, { CROT_RELAY_SELF_REGISTRATION: "1" })).toMatchObject({ selfRegistration: true });
    expect(parseRelayConfig(base, {})).not.toHaveProperty("selfRegistration");
    expect(parseRelayConfig({ ...base, selfRegistration: true }, {})).toMatchObject({ selfRegistration: true });
  });
});
