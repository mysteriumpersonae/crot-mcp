/** AD-58 replaces the rejected AD-55 driver candidate with a mandatory real
 * production AppContainer gate. AD-55/57 evidence remains in Git history.
 * This is NOT LPAC qualification and does not install third-party drivers. */
import { describe, it } from "vitest";
import { qualifyCheckedSource } from "../checked-source-qualification.js";
describe.runIf(process.platform === "win32")("AD-58 Windows native checked-source boundary", () => {
  it(
    "denies live/future source and control access, permits scratch and checked Core commits",
    qualifyCheckedSource,
    300000,
  );
});
