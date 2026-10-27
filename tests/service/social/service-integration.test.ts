/** Actual CrotService + authenticated owner channel + real local provider HTTP.
 * Memory credential backend is ONLY protocol integration evidence, not native OS qualification. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CrotService } from "../../../src/service/service.js";
import { ControlClient } from "../../../src/service/control-client.js";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import { fixtureOAuthAdapter } from "../../../src/service/social/provider-http.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { makeTempDirs, waitFor } from "../../helpers.js";
import type { SocialAccount } from "../../../src/service/social/accounts.js";
it(
  "real owner RPC connects an account with PKCE, persists no tokens, revokes provider and audits cleanup",
  { timeout: 30_000 },
  async () => {
    const dirs = await makeTempDirs(),
      stateDir = await mkdtemp(path.join(os.tmpdir(), "crot-o-"));
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const values = new Map<string, string>();
    let authorization: URL | undefined,
      revoked = 0;
    const secrets = new AccountSecrets({
      kind: "secret-service",
      get: async (p, f) => values.get(p + f),
      set: async (p, f, value) => {
        values.set(p + f, value);
      },
      delete: async (p, f) => {
        values.delete(p + f);
      },
    });
    const provider = createServer(async (req, res) => {
      const u = new URL(req.url!, "http://127.0.0.1");
      if (u.pathname === "/authorize") {
        authorization = u;
        const callback = new URL(u.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", u.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-code");
        res.writeHead(302, { location: callback.href }).end();
        return;
      }
      if (u.pathname === "/profile") {
        expect(req.headers.authorization).toBe("Bearer fixture-access");
        res.setHeader("content-type", "application/json");
        res.end('{"id":42,"login":"fixture-owner","name":"Fixture Owner"}');
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (u.pathname === "/token") {
        const p = new URLSearchParams(raw);
        expect(p.get("code_verifier")).toBeTruthy();
        expect(createHash("sha256").update(p.get("code_verifier")!).digest("base64url")).toBe(
          authorization?.searchParams.get("code_challenge"),
        );
        expect(p.get("client_secret")).toBe("fixture-secret");
        res.setHeader("content-type", "application/json");
        res.end('{"access_token":"fixture-access","refresh_token":"fixture-refresh"}');
        return;
      }
      if (u.pathname === "/revokeapp/token") {
        expect(req.method).toBe("DELETE");
        expect(JSON.parse(raw)).toEqual({ access_token: "fixture-access" });
        revoked++;
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    });
    let service: CrotService | undefined, control: ControlClient | undefined;
    try {
      await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
      const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
      const started = await CrotService.start({
        stateDir,
        privateFiles,
        launch: "managed",
        log: () => undefined,
        requestStop: () => undefined,
        command: {
          kind: "serve",
          warnings: [],
          config: {
            workspace: { root: dirs.workspace },
            environment: { path: "inherited" },
            secrets: { store: "file" },
            audit: { sink: "file", path: path.join(stateDir, "audit.jsonl") },
          },
        },
        socialAccounts: {
          secrets: async () => secrets,
          adapters: new Map([["github", fixtureOAuthAdapter("github", origin)]]),
          loopbackFixtures: true,
        },
      });
      if (started === "already_running") throw new Error("Unexpected running service");
      service = started;
      control = await ControlClient.connect({ stateDir, privateFiles });
      expect(control).toBeTruthy();
      await control!.request("accounts.configure", {
        provider: "github",
        clientId: "app",
        clientSecret: "fixture-secret",
      });
      const result = (await control!.request("accounts.connect", { provider: "github" })) as {
        authorizationUrl: string;
      };
      expect((await fetch(result.authorizationUrl)).status).toBe(200);
      let rows: SocialAccount[] = [];
      await waitFor(async () => {
        rows = ((await control!.request("accounts.list", {})) as { accounts: SocialAccount[] }).accounts;
        return rows.some((a) => a.provider === "github" && a.state === "connected");
      });
      expect(rows.find((a) => a.provider === "github")).toMatchObject({ handle: "@fixture-owner", state: "connected" });
      await control!.request("accounts.check", { provider: "github" });
      for (const file of ["social-accounts.json", "product-state.json", "product-vault.enc"])
        expect(await readFile(path.join(stateDir, file), "utf8")).not.toMatch(
          /fixture-access|fixture-refresh|fixture-secret/,
        );
      await control!.request("accounts.disconnect", { provider: "github" });
      expect(values.size).toBe(0);
      expect(revoked).toBe(1);
      control!.close();
      control = undefined;
      await service.shutdown("test complete");
      service = undefined;
      const audit = await readFile(path.join(stateDir, "audit.jsonl"), "utf8");
      expect(audit).toContain('"action":"social_account"');
      expect(audit).toContain("account.connected");
      expect(audit).toContain("account.disconnected");
      expect(audit).not.toMatch(/fixture-access|fixture-refresh|fixture-secret|fixture-code/);
    } finally {
      control?.close();
      await service?.shutdown("test cleanup");
      await new Promise<void>((r) => provider.close(() => r()));
      await rm(stateDir, { recursive: true, force: true });
      await dirs.cleanup();
    }
  },
);
