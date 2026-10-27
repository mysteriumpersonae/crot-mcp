/** AD-61: credential/control isolation, not DPI of owner-enabled raw sockets. */
import { CrotError } from "../../core/errors.js";
import type { CrotCore } from "../../core/crot-core.js";
import type { ConfinementStatus } from "../../core/platform/types.js";
import type { DeviceIdentity } from "../identity.js";

const nativeMechanisms: Partial<Record<NodeJS.Platform, ConfinementStatus["mechanism"]>> = {
  linux: "linux-bubblewrap",
  darwin: "macos-seatbelt",
  win32: "windows-appcontainer",
};

export function publicationIsolationReady(l1: ConfinementStatus, platform = process.platform): boolean {
  return (
    l1.available === true &&
    l1.sourceAccess === "core-only" &&
    l1.reason === null &&
    nativeMechanisms[platform] !== undefined &&
    l1.mechanism === nativeMechanisms[platform]
  );
}

/** Presentation of the same gate; readiness never grants entitlement or owner authority. */
export function publicationProtection(l1: ConfinementStatus) {
  const ready = publicationIsolationReady(l1);
  return {
    browserRoutes: "system_guard",
    nativeCredentialControlIsolation: ready ? "ready" : "unavailable",
    commandNetworkOn: "owner_enabled_raw_network_no_dpi",
    commandNetworkOff: "native_network_block_when_ready",
    production: ready ? "requires_verified_pro_and_owner_confirmation" : "fail_closed",
    requirements: ["fresh_verified_pro", "native_l1", "one_use_owner_confirmation", "immutable_sha256_snapshot"],
  };
}

export async function authorizeProductionPublication(host: {
  identity: Pick<DeviceIdentity, "refreshCommercialIfNeeded" | "commercialStatus">;
  core(): Pick<CrotCore, "refreshConfinement">;
  halted(): boolean;
}): Promise<void> {
  const assertHalted = () => {
    if (host.halted()) throw new CrotError("PERMISSION_DENIED", "Service is halted");
  };
  const assertCommercial = () => {
    const commercial = host.identity.commercialStatus();
    if (
      commercial.state !== "current" ||
      commercial.entitled !== true ||
      commercial.status !== "active" ||
      !["pro", "trial", "team"].includes(commercial.plan ?? "")
    )
      throw new CrotError("PERMISSION_DENIED", "A current verified Pro entitlement is required for publication");
  };
  assertHalted();
  await host.identity.refreshCommercialIfNeeded();
  assertHalted();
  assertCommercial();
  const core = host.core();
  let ready = false;
  try {
    ready = publicationIsolationReady(await core.refreshConfinement());
  } catch {
    // Never substitute cached success or expose native paths/errors to the caller.
  }
  assertHalted();
  assertCommercial();
  if (!ready || core !== host.core())
    throw new CrotError(
      "PERMISSION_DENIED",
      "Publication unavailable: fresh native credential/control isolation is required; no unconfined fallback",
    );
}
