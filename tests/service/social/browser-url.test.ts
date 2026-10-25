import { expect, it } from "vitest";
import { socialAuthorizationUrl } from "../../../src/service/social/browser-url.js";
it("Electron accepts only fixed PKCE endpoints and random loopback callbacks, never renderer destinations", () => {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: "app",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:12345/oauth/callback/" + "r".repeat(43),
  }).toString();
  expect(socialAuthorizationUrl("github", u.href)).toBe(u.href);
  for (const value of [
    u.href.replace("github.com/", "github.com.evil.example/"),
    u.href.replace("https:", "http:"),
    u.href + "&state=duplicate",
    u.href + "#fragment",
    u.href.replace("github.com", "user:pass@github.com"),
  ])
    expect(socialAuthorizationUrl("github", value)).toBeUndefined();
  expect(socialAuthorizationUrl("notion", u.href)).toBeUndefined();
  u.searchParams.set("redirect_uri", "https://attacker.example/callback");
  expect(socialAuthorizationUrl("github", u.href)).toBeUndefined();
});
