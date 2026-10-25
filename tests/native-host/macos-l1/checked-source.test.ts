import { describe, it } from "vitest";
import { qualifyCheckedSource } from "../checked-source-qualification.js";
describe.runIf(process.platform === "darwin")("AD-58 macOS native checked-source boundary", () => {
  it(
    "denies live/future source and control access, permits scratch and checked Core commits",
    qualifyCheckedSource,
    300000,
  );
});
