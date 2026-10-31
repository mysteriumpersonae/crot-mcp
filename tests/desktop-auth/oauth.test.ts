import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { beginOAuth, providerProfile } from "../../src/desktop-auth/oauth.js";
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.unstubAllGlobals();
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((yes) => server.close(() => yes()));
  return String(port);
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
describe("Screen 01 provider PKCE", () => {
  it("sends actual Google S256/state/loopback and refuses bad state, consumes callback once", async () => {
    const port = await freePort();
    let url!: URL,
      exchanged = 0,
      accepted = 0;
    const realFetch = fetch;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://oauth2.googleapis.com/token") {
        exchanged++;
        const body = init!.body as URLSearchParams;
        expect(body.get("code")).toBe("genuine-code");
        expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
          urlOpened.searchParams.get("code_challenge"),
        );
        return response({ access_token: "fixture-only-token", token_type: "Bearer" });
      }
      if (target === "https://openidconnect.googleapis.com/v1/userinfo")
        return response({
          sub: "real-subject-fixture",
          email: "verified@example.test",
          email_verified: true,
          name: "Astin",
        });
      return realFetch(url, init);
    });
    let urlOpened!: URL;
    vi.stubGlobal("fetch", request);
    const flow = await beginOAuth(
      "google",
      { GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret", CROT_AUTH_CALLBACK_PORT: port },
      async (value) => {
        url = new URL(value);
        urlOpened = url;
      },
      async (p) => {
        accepted++;
        expect(p.email).toBe("verified@example.test");
      },
    );
    closers.push(flow.cancel);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.href).not.toContain("fixture-secret");
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "genuine-code");
    callback.searchParams.set("state", "wrong");
    expect((await realFetch(callback)).status).toBe(400);
    expect(exchanged).toBe(0);
    expect(accepted).toBe(0);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    expect((await realFetch(callback)).status).toBe(200);
    await flow.completion;
    expect(exchanged).toBe(1);
    expect(accepted).toBe(1);
  });
  it("denied/cancelled/browser failure cannot admit", async () => {
    const port = await freePort();
    let url!: URL;
    const accepted = vi.fn();
    const flow = await beginOAuth(
      "github",
      { GITHUB_CLIENT_ID: "fixture-client", GITHUB_CLIENT_SECRET: "fixture-secret", CROT_AUTH_CALLBACK_PORT: port },
      async (value) => {
        url = new URL(value);
      },
      accepted,
    );
    closers.push(flow.cancel);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("error", "access_denied");
    expect((await fetch(callback)).status).toBe(400);
    await expect(flow.completion).rejects.toThrow("OAUTH_DENIED");
    expect(accepted).not.toHaveBeenCalled();
    await expect(
      beginOAuth(
        "google",
        { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", CROT_AUTH_CALLBACK_PORT: port },
        async () => {
          throw Error("browser failure");
        },
        accepted,
      ),
    ).rejects.toThrow("OAUTH_BROWSER_OR_PORT_FAILED");
  });
  it("requires verified email and binds token exchange to verifier/redirect; no token returned in profile", async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_token")) {
        const b = init!.body as URLSearchParams;
        expect(b.get("client_secret")).toBe("secret");
        expect(b.get("code_verifier")).toBe("verifier");
        expect(b.get("redirect_uri")).toBe("http://127.0.0.1:43821/oauth/callback");
        return response({ access_token: "fixture-token", token_type: "bearer" });
      }
      if (String(url).endsWith("/user"))
        return response({
          id: 42,
          login: "Astin",
          name: "Astin",
          avatar_url: "https://avatars.githubusercontent.com/u/42",
        });
      return response([{ email: "verified@example.test", primary: true, verified: true }]);
    });
    const p = await providerProfile(
      "github",
      "code",
      "verifier",
      "http://127.0.0.1:43821/oauth/callback",
      { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" },
      new AbortController().signal,
      request as typeof fetch,
    );
    expect(p).toMatchObject({ subject: "42", login: "Astin", email: "verified@example.test" });
    expect(JSON.stringify(p)).not.toContain("fixture-token");
    const invalid = vi
      .fn()
      .mockResolvedValueOnce(response({ access_token: "token" }))
      .mockResolvedValueOnce(response({ sub: "123", email: "unverified@example.test", email_verified: false }));
    await expect(
      providerProfile(
        "google",
        "code",
        "verifier",
        "http://127.0.0.1:43821/oauth/callback",
        { GOOGLE_CLIENT_ID: "id" },
        new AbortController().signal,
        invalid,
      ),
    ).rejects.toThrow("OAUTH_PROFILE_INVALID");
  });
  it("does not start OAuth without required configuration", async () => {
    const browser = vi.fn(),
      accept = vi.fn();
    await expect(beginOAuth("google", {}, browser, accept)).rejects.toThrow("GOOGLE_NOT_CONFIGURED");
    await expect(beginOAuth("github", { GITHUB_CLIENT_ID: "id" }, browser, accept)).rejects.toThrow(
      "GITHUB_SECRET_MISSING",
    );
    expect(browser).not.toHaveBeenCalled();
  });
});
