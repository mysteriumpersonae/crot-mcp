import { describe, it } from "vitest";
import { qualifyCheckedSource } from "../checked-source-qualification.js";
describe.runIf(process.platform === "linux" && process.env.CROT_L1_REQUIRED === "1")(
  "AD-58 Linux native checked-source boundary",
  () => {
    it(
      "denies live/future source and control access, permits scratch and checked Core commits",
      qualifyCheckedSource,
      300000,
    );
  },
);
