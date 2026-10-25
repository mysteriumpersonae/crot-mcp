import { expect, it } from "vitest";
import { decodeSecretViewCandidate, decodeSecretViewData } from "./diagnostics/secret-view-protocol.js";
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

it("reports pre-callback data refusal without upgrading raw isolation to usable data", () => {
  expect(decodeSecretViewData("CROT_VIEW_DATA:0:1:5:0:0:00000000")).toEqual({
    actor: "appContainer",
    phase: "open",
    win32Error: 5,
    errorSaturated: false,
    createCallbacks: 0,
    authorizedCallbacks: 0,
    lastCreateStatus: "00000000",
  });
  expect(decodeSecretViewData("CROT_VIEW_DATA:1:7:255:1:1:00000000\r")).toMatchObject({
    actor: "lpac",
    phase: "flush",
    errorSaturated: true,
  });
});
it.each([
  "CROT_VIEW_DATA:2:1:5:0:0:00000000",
  "CROT_VIEW_DATA:0:9:5:0:0:00000000",
  "CROT_VIEW_DATA:0:1:256:0:0:00000000",
  "CROT_VIEW_DATA:0:1:5:0:1:00000000",
  "CROT_VIEW_DATA:0:1:5:4294967296:0:00000000",
  "CROT_VIEW_DATA:0:1:5:0:0:private-path",
  "prefix CROT_VIEW_DATA:0:1:5:0:0:00000000",
])("rejects malformed data diagnostics: %s", (line) => {
  expect(decodeSecretViewData(line)).toBeUndefined();
});
