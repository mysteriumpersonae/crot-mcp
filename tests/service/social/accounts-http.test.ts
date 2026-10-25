/** Real loopback HTTP provider; memory secret backend is composition evidence, NOT native OS storage qualification. */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import { SocialAccountService, type SocialAccount } from "../../../src/service/social/accounts.js";
import {
  fixtureOAuthAdapter,
  productionOAuthAdapters,
  SOCIAL_OAUTH_ENDPOINTS,
} from "../../../src/service/social/provider-http.js";
let service: SocialAccountService | undefined, server: Server | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});
async function fixture() {
  let authorization: URL | undefined,
    active = false,
    tokenCalls = 0,
    revokeCalls = 0,
    revokeFailed = false;
  const issued = new Set<string>(),
    values = new Map<string, string>(),
    audits: string[] = [],
    journal: SocialAccount[][] = [];
  const secrets = new AccountSecrets({
    kind: "secret-service",
    get: async (p, f) => values.get(p + f),
    set: async (p, f, v) => {
      values.set(p + f, v);
    },
    delete: async (p, f) => {
      values.delete(p + f);
    },
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (url.pathname === "/authorize") {
      authorization = url;
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      redirect.searchParams.set("code", "one-time-code-" + tokenCalls);
      res.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      const p = new URLSearchParams(raw),
        code = p.get("code")!;
      if (
        issued.has(code) ||
        p.get("client_secret") !== "fixture-app-secret" ||
        p.get("redirect_uri") !== authorization?.searchParams.get("redirect_uri") ||
        createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url") !== authorization?.searchParams.get("code_challenge")
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
        return;
      }
      issued.add(code);
      tokenCalls++;
      active = true;
      res.setHeader("content-type", "application/json");
      res.end('{"access_token":"fixture-access","refresh_token":"fixture-refresh"}');
      return;
    }
    if (url.pathname === "/profile") {
      if (!active || req.headers.authorization !== "Bearer fixture-access") {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"revoked"}');
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        '{"id":42,"login":"real-fixture","name":"Fixture profile","avatar_url":"https://avatars.githubusercontent.com/u/42"}',
      );
      return;
    }
    if (url.pathname === "/revokefixture-client/token") {
      expect(req.method).toBe("DELETE");
      expect(req.headers.authorization).toBe(
        "Basic " + Buffer.from("fixture-client:fixture-app-secret").toString("base64"),
      );
      expect(JSON.parse(raw)).toEqual({ access_token: "fixture-access" });
      revokeCalls++;
      active = false;
      res.writeHead(revokeFailed ? 503 : 204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let browserUrl = "";
  const adapter = fixtureOAuthAdapter("github", origin);
  service = new SocialAccountService(
    {
      secrets: async () => secrets,
      persist: async (rows) => {
        journal.push(structuredClone([...rows]));
      },
      audit: async (e) => {
        audits.push(e.operation);
      },
      openBrowser: async (url) => {
        browserUrl = url;
      },
      loopbackFixtures: true,
    },
    new Map([["github", adapter]]),
  );
  await service.configure("github", "fixture-client", "fixture-app-secret");
  const authorize = async () => {
    await service!.connect("github");
    expect(new URL(browserUrl).origin).toBe(origin);
    expect((await fetch(browserUrl)).status).toBe(200);
    const deadline = Date.now() + 3000;
    while (service!.list().find((a) => a.provider === "github")?.state !== "connected") {
      if (Date.now() > deadline) throw new Error("Account failed to connect");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    values,
    audits,
    journal,
    authorize,
    adapter,
    tokenCalls: () => tokenCalls,
    revokeCalls: () => revokeCalls,
    expire: () => {
      active = false;
    },
    failRevoke: () => {
      revokeFailed = true;
    },
  };
}
it("actual OAuth -> token/profile -> OS-store interface -> provider revoke -> verified local deletion, without renderer token disclosure", async () => {
  const f = await fixture();
  await f.authorize();
  expect(f.tokenCalls()).toBe(1);
  expect(service!.list().find((a) => a.provider === "github")).toMatchObject({
    state: "connected",
    handle: "@real-fixture",
    name: "Fixture profile",
  });
  expect(JSON.stringify(f.journal)).not.toContain("fixture-access");
  expect(JSON.stringify(f.journal)).not.toContain("fixture-refresh");
  expect(JSON.stringify(service!.list())).not.toContain("fixture-app-secret");
  const generation = service!.list().find((a) => a.provider === "github")!.generation;
  const result = await service!.disconnect("github");
  expect(f.revokeCalls()).toBe(1);
  expect(result).toMatchObject({ state: "disconnected", revocation: "requested", cleanup: "complete" });
  expect(result.generation).not.toBe(generation);
  expect(f.values.size).toBe(0);
  expect(f.audits).toEqual(["account.configured", "account.connected", "account.disconnected"]);
});
it("provider-side revocation becomes reauth_required; a failed remote revoke still removes every local secret", async () => {
  const f = await fixture();
  await f.authorize();
  f.expire();
  await expect(
    service!.withCredential("github", (access, signal) => f.adapter.profile(access, signal)),
  ).rejects.toThrow("revoked");
  expect(service!.list().find((a) => a.provider === "github")?.state).toBe("reauth_required");
  expect(f.values.has("githubaccess")).toBe(false);
  expect(f.values.has("githubrefresh")).toBe(false);
  await f.authorize();
  f.failRevoke();
  expect(await service!.disconnect("github")).toMatchObject({
    state: "disconnected",
    revocation: "failed",
    cleanup: "complete",
  });
  expect(f.values.size).toBe(0);
});
it("does not claim Notion supports native PKCE", () => {
  expect(SOCIAL_OAUTH_ENDPOINTS.notion.pkce).toBe(false);
  expect(productionOAuthAdapters().get("notion")).toMatchObject({
    pkce: true,
    authorizationEndpoint: "https://mcp.crot.network/oauth/notion/authorize",
  });
});
