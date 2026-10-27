import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { startOAuthLoopback, type OAuthFlow } from "../../../src/service/social/oauth-loopback.js";
let flow: OAuthFlow | undefined, provider: Server | undefined;
afterEach(async () => {
  await flow?.cancel();
  flow = undefined;
  if (provider) await new Promise<void>((r) => provider!.close(() => r()));
  provider = undefined;
});
it.each(["base64url", "hex"] as const)(
  "actual HTTP OAuth fixture binds state, callback, single use and S256 %s without exposing code",
  async (encoding) => {
    let authorization: URL | undefined,
      exchanges = 0;
    provider = createServer(async (req, res) => {
      if (req.url !== "/token" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      if (
        p.get("code") !== "server-only-code" ||
        p.get("redirect_uri") !== authorization?.searchParams.get("redirect_uri") ||
        createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest(encoding) !== authorization?.searchParams.get("code_challenge")
      ) {
        res.writeHead(400).end();
        return;
      }
      exchanges++;
      res.setHeader("content-type", "application/json");
      res.end('{"access_token":"server-only-token"}');
    });
    await new Promise<void>((r) => provider!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    flow = await startOAuthLoopback({
      authorizationEndpoint: origin + "/authorize",
      clientId: "fixture-client",
      scopes: ["publish"],
      challengeEncoding: encoding,
      allowLoopbackFixture: true,
      openBrowser: async (url) => {
        authorization = new URL(url);
      },
      exchange: async ({ code, verifier, redirectUri, signal }) => {
        const response = await fetch(origin + "/token", {
          method: "POST",
          redirect: "error",
          signal,
          body: new URLSearchParams({ code, code_verifier: verifier, redirect_uri: redirectUri }),
        });
        expect(response.ok).toBe(true);
        expect(await response.json()).toEqual({ access_token: "server-only-token" });
      },
    });
    const callback = authorization!.searchParams.get("redirect_uri")!,
      state = authorization!.searchParams.get("state")!;
    expect((await fetch(callback + "?state=attacker&code=server-only-code")).status).toBe(400);
    expect(exchanges).toBe(0);
    expect((await fetch(callback + `?state=${state}&state=${state}&code=server-only-code`)).status).toBe(400);
    expect(
      (
        await fetch(callback + `?state=${state}&code=server-only-code`, {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(400);
    const response = await fetch(callback + `?state=${state}&code=server-only-code`);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("server-only-code");
    await flow.completion;
    expect(exchanges).toBe(1);
    await expect(fetch(callback + `?state=${state}&code=server-only-code`)).rejects.toThrow();
    expect(exchanges).toBe(1);
  },
);
it("refuses plaintext external OAuth and times out/cancels without redeeming", async () => {
  const exchange = async () => {
    throw new Error("must not exchange");
  };
  await expect(
    startOAuthLoopback({
      authorizationEndpoint: "http://attacker.example/authorize",
      clientId: "id",
      scopes: [],
      openBrowser: async () => {},
      exchange,
    }),
  ).rejects.toThrow("endpoint");
  flow = await startOAuthLoopback({
    authorizationEndpoint: "https://provider.example/authorize",
    clientId: "id",
    scopes: [],
    openBrowser: async () => {},
    exchange,
    timeoutMs: 25,
  });
  await expect(flow.completion).rejects.toThrow("timed out");
});
