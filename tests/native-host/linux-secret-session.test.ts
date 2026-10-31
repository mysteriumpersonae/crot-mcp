import { mkdtemp, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { startLinuxSecretSession } from "./linux-secret-session.js";
import { createLibsecretBackend } from "../../src/service/secrets/backends.js";

it.runIf(process.platform === "linux" && process.env.CROT_SECRET_SESSION_TEST === "1")(
  "uses an isolated real unlocked Secret Service across fresh sessions",
  async () => {
    for (let i = 0; i < 3; i++) {
      const state = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-secret-session-")));
      let session: Awaited<ReturnType<typeof startLinuxSecretSession>> | undefined;
      try {
        session = await startLinuxSecretSession(state);
        expect(session.env.HOME).toBe(path.join(state, "secret-home"));
        expect(session.env.XDG_DATA_HOME).toBe(path.join(state, "secret-home", ".local", "share"));
        expect(session.env.HOME).not.toBe(process.env.HOME);
        const backend = createLibsecretBackend(state, { tool: "/usr/bin/secret-tool", env: session.env });
        const canary = "fixture-only-" + randomUUID();
        await backend.set("control-token", canary);
        expect((await backend.get("control-token")) === canary).toBe(true);
        await backend.delete("control-token");
        expect(await backend.get("control-token")).toBeUndefined();
      } finally {
        await session?.close();
        await rm(state, { recursive: true, force: true });
      }
    }
  },
  120000,
);
