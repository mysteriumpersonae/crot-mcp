import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";

it("Chat separates platforms, skills and connected local/cloud agents; composer and counters match geometry", async () => {
  await promisify(execFile)(process.execPath, ["scripts/ui-e2e.mjs", "--chat-groups"], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
}, 120_000);
