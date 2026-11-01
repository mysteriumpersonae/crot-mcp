import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
it("Agents center uses real token rotation/audit and provider checks without changing sidebar", async () => {
  await promisify(execFile)(process.execPath, ["scripts/ui-e2e.mjs", "--agents"], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}, 120_000);
