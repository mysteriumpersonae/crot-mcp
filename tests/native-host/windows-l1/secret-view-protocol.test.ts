import { expect, it } from "vitest";
import { decodeSecretViewCandidate } from "./diagnostics/secret-view-protocol.js";
it("keeps AD-55 live-data evidence distinct from historical NUL/control-only packets", () => {
  const result = decodeSecretViewCandidate("c0100100");
  expect(result).toMatchObject({
    protocolVersion: "ad55-v1",
    rawDevicePackageGrant: false,
    appContainer: { ready: true, liveDataReadWrite: true, win32Zero: "access-denied", ntLiteralZero: "access-denied" },
    lpac: { ready: true, liveDataReadWrite: true },
  });
  expect(JSON.stringify(result)).not.toContain("nulReadWriteOpened");
});
it.each(["b0100100", "c4100100", "c01001000", "not-hex", "c0000800"])(
  "refuses unrelated/malformed or invalid-stage packets: %s",
  (hex) => {
    expect(decodeSecretViewCandidate(hex)).toBeUndefined();
  },
);
it("does not turn missing data entry or a raw opened handle into denial proof", () => {
  expect(decodeSecretViewCandidate("c0000001")).toMatchObject({
    appContainer: { liveDataReadWrite: false, win32Zero: "opened" },
  });
});
