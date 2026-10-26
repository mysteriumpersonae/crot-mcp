import { describe, it } from "vitest";
import { qualifyCredentialControl } from "../credential-control-qualification.js";
describe.runIf(process.platform === "linux" && process.env.CROT_L1_REQUIRED === "1")(
  "native OAuth credential and owner control isolation",
  () => {
    it(
      "denies terminal and Custom Skill access to a real OS credential and live owner socket",
      qualifyCredentialControl,
      300000,
    );
  },
);
