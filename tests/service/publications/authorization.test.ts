import { expect, it, vi } from "vitest";
import {
  authorizeProductionPublication,
  publicationIsolationReady,
  publicationProtection,
} from "../../../src/service/publications/authorization.js";
import type { ConfinementStatus } from "../../../src/core/platform/types.js";
import type { CommercialStatus } from "../../../src/service/protocol.js";

const mechanisms = {
  linux: "linux-bubblewrap",
  darwin: "macos-seatbelt",
  win32: "windows-appcontainer",
} as const;
const ready: ConfinementStatus = {
  sourceAccess: "core-only",
  mechanism: mechanisms[process.platform as keyof typeof mechanisms],
  available: true,
  network: "on",
  reason: null,
  detail: "AD-58: source is core-only; empty scratch",
};
const paid: CommercialStatus = { state: "current", entitled: true, status: "active", plan: "pro" };
function fixture() {
  let commercial = paid,
    l1 = ready,
    halted = false;
  const core = { refreshConfinement: vi.fn(async () => l1) };
  const identity = {
    refreshCommercialIfNeeded: vi.fn(async () => {}),
    commercialStatus: () => commercial,
  };
  const host = { identity, core: () => core, halted: () => halted };
  return {
    host,
    core,
    identity,
    commercial: (value: CommercialStatus) => {
      commercial = value;
    },
    l1: (value: ConfinementStatus) => {
      l1 = value;
    },
    halt: () => {
      halted = true;
    },
  };
}

it.each(["pro", "trial", "team"] as const)(
  "admits fresh active %s only with refreshed native isolation",
  async (plan) => {
    const f = fixture();
    f.commercial({ ...paid, plan });
    f.identity.refreshCommercialIfNeeded.mockImplementationOnce(async () => {
      expect(f.core.refreshConfinement).not.toHaveBeenCalled();
    });
    await expect(authorizeProductionPublication(f.host)).resolves.toBeUndefined();
    expect(f.identity.refreshCommercialIfNeeded).toHaveBeenCalledOnce();
    expect(f.core.refreshConfinement).toHaveBeenCalledOnce();
    f.l1({ ...ready, network: "off" });
    await expect(authorizeProductionPublication(f.host)).resolves.toBeUndefined();
  },
);

it.each<CommercialStatus>([
  { state: "unknown" },
  { ...paid, state: "unknown" },
  { ...paid, plan: "free" },
  { ...paid, entitled: false },
  { ...paid, entitled: undefined },
  { ...paid, status: "past_due" },
  { ...paid, status: "canceled" },
  { ...paid, status: "expired" },
])("refuses non-current/non-active/non-entitled commercial state %j", async (commercial) => {
  const f = fixture();
  f.commercial(commercial);
  await expect(authorizeProductionPublication(f.host)).rejects.toThrow("Pro entitlement");
  expect(f.core.refreshConfinement).not.toHaveBeenCalled();
});

it.each<Partial<ConfinementStatus>>([
  { available: false },
  { sourceAccess: undefined },
  { mechanism: "none" },
  { reason: "self_test_failed" },
  { reason: "artifact_export_pending" },
  { mechanism: process.platform === "win32" ? "linux-bubblewrap" : "windows-appcontainer" },
])("refuses missing/inconsistent native readiness %j on every call", async (patch) => {
  const f = fixture();
  await authorizeProductionPublication(f.host);
  f.l1({ ...ready, ...patch });
  await expect(authorizeProductionPublication(f.host)).rejects.toThrow("fresh native credential/control isolation");
  expect(publicationProtection({ ...ready, ...patch }).production).toBe("fail_closed");
});

it("never uses a previous success after a readiness exception or a commercial refresh failure", async () => {
  const f = fixture();
  await authorizeProductionPublication(f.host);
  f.core.refreshConfinement.mockRejectedValueOnce(new Error("private native path"));
  await expect(authorizeProductionPublication(f.host)).rejects.toThrow("no unconfined fallback");
  f.identity.refreshCommercialIfNeeded.mockRejectedValueOnce(new Error("commercial unavailable"));
  await expect(authorizeProductionPublication(f.host)).rejects.toThrow("commercial unavailable");
  expect(f.core.refreshConfinement).toHaveBeenCalledTimes(2);
});

it("rechecks halt, entitlement and Core identity across asynchronous readiness", async () => {
  for (const mutation of ["halt", "commercial", "core"] as const) {
    const f = fixture();
    f.core.refreshConfinement.mockImplementationOnce(async () => {
      if (mutation === "halt") f.halt();
      if (mutation === "commercial") f.commercial({ state: "unknown" });
      if (mutation === "core") f.host.core = () => ({ refreshConfinement: vi.fn(async () => ready) });
      return ready;
    });
    await expect(authorizeProductionPublication(f.host)).rejects.toThrow();
  }
  const f = fixture();
  f.halt();
  await expect(authorizeProductionPublication(f.host)).rejects.toThrow("halted");
  expect(f.identity.refreshCommercialIfNeeded).not.toHaveBeenCalled();
});

it("accepts only the qualified native mechanism for each host OS and never claims DPI", () => {
  for (const [platform, mechanism] of Object.entries(mechanisms))
    expect(publicationIsolationReady({ ...ready, mechanism }, platform as NodeJS.Platform)).toBe(true);
  expect(publicationIsolationReady(ready, "freebsd")).toBe(false);
  expect(publicationProtection(ready)).toMatchObject({
    nativeCredentialControlIsolation: "ready",
    commandNetworkOn: "owner_enabled_raw_network_no_dpi",
    commandNetworkOff: "native_network_block_when_ready",
    production: "requires_verified_pro_and_owner_confirmation",
    requirements: ["fresh_verified_pro", "native_l1", "one_use_owner_confirmation", "immutable_sha256_snapshot"],
  });
});
