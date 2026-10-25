/** AD-55 experimental packet; never a production availability predicate. */
import { decodeControlProfileDiagnostic } from "../../../../src/native-host/windows-l1/control-profile-probe.js";
export function decodeSecretViewCandidate(hex: string) {
  if (!/^[0-9a-f]{8}$/.test(hex)) return undefined;
  const value = Number.parseInt(hex, 16),
    header = value >>> 24;
  if (header < 0xc0 || header > 0xc3) return undefined;
  const old = decodeControlProfileDiagnostic(((value - 0x10000000) >>> 0).toString(16));
  if (!old || !old.completed) return undefined;
  const profile = (p: typeof old.appContainer) => {
    if (!p.ready) return p;
    const { nulReadWriteOpened, ...rest } = p;
    return { ...rest, liveDataReadWrite: nulReadWriteOpened };
  };
  return {
    protocolVersion: "ad55-v1" as const,
    ownerControls: old.ownerControls,
    ownerNtLiteralZero: old.ownerNtLiteralZero,
    rawDevicePackageGrant: false as const,
    appContainer: profile(old.appContainer),
    lpac: profile(old.lpac),
  };
}
