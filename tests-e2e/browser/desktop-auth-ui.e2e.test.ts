/** Real Chromium, shipped Screen 01 renderer; synthetic IPC/vault/SMTP fixtures only. */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { chromeExecutable } from "./harness.js";
it("qualifies secure bootstrap, password/OTP and RU/EN in shipped Screen 01", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/desktop-auth-e2e.mjs"], {
    timeout: 110_000,
    maxBuffer: 131072,
    env: {
      ...process.env,
      CROT_E2E_CHROME: chromeExecutable(),
      CROT_AUTH_EVIDENCE: path.join(process.env.CROT_E2E_ARTIFACTS || "artifacts", "screen-01"),
    },
  });
  expect(stdout).toContain("PASS Screen 01 + Admin Bootstrap UI");
});
