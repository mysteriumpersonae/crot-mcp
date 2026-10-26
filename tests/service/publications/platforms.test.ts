/** Real local HTTP protocol fixtures, not fetch mocks. No external publication is possible. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { fixturePublisher, type PublicationPayload } from "../../../src/service/publications/platforms.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await handler(req, res, Buffer.concat(chunks));
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const reply = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
function payload(provider: "youtube" | "tiktok" | "x"): PublicationPayload {
  const bytes = Buffer.from("\0\0\0\x18ftypmp42fixture");
  return {
    access: "fixture-secret-not-renderer",
    signal: new AbortController().signal,
    media: {
      snapshot: {
        version: 1,
        id: randomUUID(),
        project: "p",
        name: "clip.mp4",
        mime: "video/mp4",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      data: bytes,
    },
    record: {
      id: randomUUID(),
      project: "p",
      createdAt: Date.now(),
      state: "processing",
      request: { provider, accountId: provider + ":recipient", title: "Title", description: "Description" },
      account: {
        id: provider + ":recipient",
        provider,
        generation: "g",
        handle: "@fixture",
        privacy: ["public", "private", "draft"],
        destinationLabel: "@fixture",
      },
      fields: {
        title: "Title",
        description: "Description",
        privacy: provider === "tiktok" ? "draft" : provider === "x" ? "public" : "private",
        termsAccepted: true,
        comments: false,
        duet: false,
        stitch: false,
        commercial: false,
        ownBrand: false,
        brandedContent: false,
      },
    },
  };
}
it("YouTube uploads fixed bytes, explicit privacy and waits for actual processing/privacy confirmation", async () => {
  const p = payload("youtube"),
    calls: string[] = [],
    bodies: Buffer[] = [];
  const origin = await fixture((req, res, body) => {
    calls.push(req.method + " " + req.url);
    bodies.push(body);
    expect(req.headers.authorization).toBe("Bearer " + p.access);
    if (req.url!.startsWith("/youtube/v3/channels")) {
      reply(res, { items: [{ id: "recipient" }] });
      return;
    }
    if (req.method === "POST") {
      const data = JSON.parse(body.toString());
      expect(data.status.privacyStatus).toBe("private");
      res.writeHead(200, { location: origin + "/upload" });
      res.end();
    } else if (req.method === "PUT") {
      expect(body).toEqual(p.media!.data);
      reply(res, { id: "video-1" });
    } else reply(res, { items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] });
  });
  expect(await fixturePublisher(origin)(p)).toEqual({ state: "published", id: "video-1" });
  expect(calls).toHaveLength(4);
  expect(bodies[2]).toEqual(p.media!.data);
});
it("YouTube refuses upload redirects/foreign destinations and mismatched applied privacy", async () => {
  let mode = "foreign",
    puts = 0;
  const origin = await fixture((req, res) => {
    if (req.url!.startsWith("/youtube/v3/channels")) {
      reply(res, { items: [{ id: "recipient" }] });
      return;
    }
    if (req.method === "POST") {
      res.writeHead(mode === "redirect" ? 302 : 200, {
        location: mode === "foreign" || mode === "redirect" ? "http://127.0.0.1:1/steal" : origin + "/upload",
      });
      res.end();
    } else if (req.method === "PUT") {
      puts++;
      reply(res, { id: "v" });
    } else reply(res, { items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] });
  });
  await expect(fixturePublisher(origin)(payload("youtube"))).rejects.toThrow("destination");
  expect(puts).toBe(0);
  mode = "redirect";
  await expect(fixturePublisher(origin)(payload("youtube"))).rejects.toThrow();
  expect(puts).toBe(0);
  mode = "privacy";
  await expect(fixturePublisher(origin)(payload("youtube"))).rejects.toThrow("privacy");
  expect(puts).toBe(1);
});
it("TikTok uses inbox drafts only, sends snapshot without bearer to signed upload, records draft_uploaded", async () => {
  const p = payload("tiktok"),
    calls: string[] = [];
  const origin = await fixture((req, res, body) => {
    calls.push(req.url!);
    if (req.url!.startsWith("/v2/user/info/")) {
      reply(res, { error: { code: "ok" }, data: { user: { open_id: "recipient" } } });
      return;
    }
    if (req.url === "/upload") {
      expect(req.headers.authorization).toBeUndefined();
      expect(body).toEqual(p.media!.data);
      expect(req.headers["content-range"]).toBe(`bytes 0-${body.length - 1}/${body.length}`);
      res.end();
      return;
    }
    expect(req.headers.authorization).toBe("Bearer " + p.access);
    if (req.url!.includes("/inbox/")) {
      expect(JSON.parse(body.toString()).source_info.video_size).toBe(p.media!.data.length);
      reply(res, { error: { code: "ok" }, data: { publish_id: "draft-1", upload_url: origin + "/upload" } });
    } else reply(res, { error: { code: "ok" }, data: { status: "SEND_TO_USER_INBOX" } });
  });
  expect(await fixturePublisher(origin)(p)).toEqual({ state: "draft_uploaded", id: "draft-1" });
  expect(calls).toHaveLength(4);
  expect(calls.some((c) => c.includes("/video/init/") && !c.includes("inbox"))).toBe(false);
  p.record.fields!.privacy = "public";
  await expect(fixturePublisher(origin)(p)).rejects.toThrow("draft");
  expect(calls).toHaveLength(4);
});
it("X revalidates exact unprotected account before uploading image and creates a public post", async () => {
  const p = payload("x");
  p.media!.snapshot.mime = "image/png";
  p.media!.snapshot.name = "image.png";
  const calls: string[] = [];
  const origin = await fixture((req, res, body) => {
    calls.push(req.method + " " + req.url);
    expect(req.headers.authorization).toBe("Bearer " + p.access);
    if (req.method === "GET") reply(res, { data: { id: "recipient", protected: false } });
    else if (req.url === "/2/media/upload") {
      expect(body.includes(p.media!.data)).toBe(true);
      reply(res, { data: { id: "image-1" } });
    } else {
      const data = JSON.parse(body.toString());
      expect(data.media.media_ids).toEqual(["image-1"]);
      expect(data.text).toBe("Title\n\nDescription");
      reply(res, { data: { id: "post-1" } });
    }
  });
  expect(await fixturePublisher(origin)(p)).toEqual({ state: "published", id: "post-1" });
  expect(calls).toEqual(["GET /2/users/me?user.fields=protected", "POST /2/media/upload", "POST /2/tweets"]);
});
it("X refuses protected, substituted or unverifiable recipient before external write", async () => {
  let profile: Record<string, unknown> = { id: "recipient", protected: true },
    writes = 0;
  const origin = await fixture((req, res) => {
    if (req.method !== "GET") writes++;
    reply(res, { data: profile });
  });
  for (const data of [
    { id: "recipient", protected: true },
    { id: "attacker", protected: false },
    { id: "recipient" },
  ]) {
    profile = data;
    await expect(fixturePublisher(origin)(payload("x"))).rejects.toThrow("recipient");
  }
  expect(writes).toBe(0);
});
it("does not retry ambiguous sends and rejects unsupported controls before sending", async () => {
  let writes = 0;
  const origin = await fixture((req, res) => {
    if (req.method === "GET") reply(res, { data: { id: "recipient", protected: false } });
    else {
      writes++;
      req.socket.destroy();
    }
  });
  const p = payload("x");
  delete p.media;
  await expect(fixturePublisher(origin)(p)).rejects.toThrow();
  expect(writes).toBe(1);
  p.record.fields!.commercial = true;
  p.record.fields!.ownBrand = true;
  await expect(fixturePublisher(origin)(p)).rejects.toThrow("unsupported");
  expect(writes).toBe(1);
});
it("never accepts a remote or credential-bearing test endpoint", () => {
  for (const url of [
    "https://api.x.com",
    "http://localhost:9000",
    "http://user:pass@127.0.0.1:9000",
    "http://127.0.0.1:9000/path",
    "http://127.0.0.1:9000/",
  ])
    expect(() => fixturePublisher(url)).toThrow();
});
it("YouTube and TikTok revalidate the OAuth recipient before starting any upload", async () => {
  let writes = 0;
  const origin = await fixture((req, res) => {
    if (req.method !== "GET") writes++;
    if (req.url!.startsWith("/youtube/v3/channels")) reply(res, { items: [{ id: "substituted" }] });
    else reply(res, { error: { code: "ok" }, data: { user: { open_id: "substituted" } } });
  });
  for (const provider of ["youtube", "tiktok"] as const)
    await expect(fixturePublisher(origin)(payload(provider))).rejects.toThrow("recipient");
  expect(writes).toBe(0);
});
