import { expect, it } from "vitest";
import { createServer } from "node:http";
import { createTestCore, testContext } from "../../helpers.js";
import { socialWriteTarget } from "../../../src/core/publications/network-boundary.js";
it("denies generic social writes in Full Control before DNS/I/O and after a real HTTP redirect", async () => {
  const server = createServer((_req, res) => res.writeHead(307, { location: "https://api.x.com/2/tweets" }).end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const core = await createTestCore({
    workspace: { root: process.cwd() },
    permissions: { mode: "full_control", network: { allow: [`127.0.0.1:${port}`, "api.x.com"] } },
  });
  try {
    for (const host of ["api.x.com", "api.github.com", "api.notion.com", "open.tiktokapis.com", "www.googleapis.com"])
      await expect(
        core.network.request(testContext, { url: `https://${host}/publish`, method: "POST" }),
      ).rejects.toMatchObject({
        code: host === "open.tiktokapis.com" ? "PUBLICATION_BYPASS_DENIED" : "PERMISSION_DENIED",
      });
    await expect(
      core.network.request(testContext, {
        url: `http://127.0.0.1:${port}/redirect`,
        method: "POST",
        followRedirects: true,
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_BYPASS_DENIED" });
    expect(socialWriteTarget(new URL("https://api.x.com.attacker.example/post"), "POST")).toBe(false);
    expect(socialWriteTarget(new URL("https://api.x.com/profile"), "GET")).toBe(false);
  } finally {
    await core.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("does not accept GET-with-body or method-override headers/query as a write-policy bypass", () => {
  const url = new URL("https://api.x.com/2/tweets");
  expect(socialWriteTarget(url, "GET", { "X-HTTP-Method-Override": "POST" })).toBe(true);
  expect(socialWriteTarget(url, "GET", {}, Buffer.from("{}"))).toBe(true);
  expect(socialWriteTarget(new URL(url.href + "?_method=POST"), "GET")).toBe(true);
});

it("refuses protected OAuth/publication routes even with GET and explicit network allow", async () => {
  const core = await createTestCore({
    workspace: { root: process.cwd() },
    permissions: {
      mode: "full_control",
      network: { allow: ["accounts.google.com", "oauth2.googleapis.com", "api.x.com"] },
    },
  });
  try {
    for (const url of [
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://oauth2.googleapis.com/token",
      "https://api.x.com/2/tweets",
    ])
      await expect(core.network.request(testContext, { url, method: "GET" })).rejects.toMatchObject({
        code: "PUBLICATION_BYPASS_DENIED",
      });
  } finally {
    await core.shutdown();
  }
});
