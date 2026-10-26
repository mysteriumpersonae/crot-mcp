import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { AccountAvatars, avatarUrl, avatarMime } from "../../../src/service/social/avatars.js";
import type { SocialAccount } from "../../../src/service/social/accounts.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=",
  "base64",
);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const account: SocialAccount = {
  provider: "x",
  id: "x:1",
  generation: "g",
  state: "connected",
  handle: "@fixture",
  avatar: "https://pbs.twimg.com/profile_images/fixture.png",
};
it("pins HTTPS provider hosts and refuses credentials, ports, lookalike suffixes and cross-provider hosts", () => {
  expect(avatarUrl("x", account.avatar!)).toBeInstanceOf(URL);
  for (const value of [
    "http://pbs.twimg.com/a",
    "https://pbs.twimg.com.evil.test/a",
    "https://pbs.twimg.com@evil.test/a",
    "https://user:pass@pbs.twimg.com/a",
    "https://pbs.twimg.com:444/a",
    "https://127.0.0.1/a",
    "data:image/svg+xml,svg",
    "https://pbs.twimg.com/a#x",
  ])
    expect(avatarUrl("x", value)).toBeUndefined();
  expect(avatarUrl("youtube", account.avatar!)).toBeUndefined();
  expect(avatarMime(png)).toBe("image/png");
  expect(avatarMime(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeUndefined();
  const huge = Buffer.from(png);
  huge.writeUInt32BE(65535, 16);
  expect(avatarMime(huge)).toBeUndefined();
});
it("actual local HTTP avatar transport enforces MIME/magic/size/redirect constraints, caches raster bytes and sends no credentials", async () => {
  let hits = 0,
    route = "/valid";
  const server = createServer((req, res) => {
    hits++;
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    switch (req.url) {
      case "/redirect":
        res.writeHead(302, { location: "https://attacker.invalid/svg" }).end();
        break;
      case "/large":
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.alloc(24577));
        break;
      case "/svg":
        res.writeHead(200, { "content-type": "image/png" }).end('<svg onload="x"/>');
        break;
      case "/mismatch":
        res.writeHead(200, { "content-type": "image/jpeg" }).end(png);
        break;
      default:
        res.writeHead(200, { "content-type": "image/png" }).end(png);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const avatars = new AccountAvatars((async (input, init) => {
    expect(String(input)).toBe(account.avatar);
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    return fetch(origin + route, init);
  }) as typeof fetch);
  cleanup.unshift(async () => avatars.close());
  expect((await avatars.get(account)).data).toBe(`data:image/png;base64,${png.toString("base64")}`);
  await avatars.get(account);
  expect(hits).toBe(1);
  for (const value of ["/large", "/svg", "/mismatch", "/redirect"]) {
    route = value;
    avatars.clear();
    expect((await avatars.get(account)).data).toBeUndefined();
  }
  const before = hits;
  expect((await avatars.get({ ...account, avatar: "https://attacker.invalid/svg" })).data).toBeUndefined();
  expect((await avatars.get({ ...account, state: "disconnected" })).data).toBeUndefined();
  expect(hits).toBe(before);
  avatars.close();
  expect((await avatars.get(account)).data).toBeUndefined();
});
