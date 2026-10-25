/** Actual Core + account runtime + local OAuth/upload HTTP. Not the shipped owner-RPC/Chromium acceptance test. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PublicationRuntime } from "../../../src/service/publications/runtime.js";
import { fixturePublisher } from "../../../src/service/publications/platforms.js";
import { SocialAccountRuntime } from "../../../src/service/social/runtime.js";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import { fixtureOAuthAdapter } from "../../../src/service/social/provider-http.js";
import type { PrivateFileProtection } from "../../../src/core/platform/types.js";
import { createTestCore, makeTempDirs, testContext, waitFor } from "../../helpers.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
const protection: PrivateFileProtection = {
  mechanism: "posix-mode",
  enforced: true,
  fileMode: 0o600,
  ensureDirectory: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  inspect: async () => ({
    mechanism: "posix-mode",
    ownerOnly: true,
    detail: "Trusted protocol fixture; not native ACL evidence",
  }),
};
async function setup() {
  const dirs = await makeTempDirs(),
    stateDir = path.join(dirs.outside, "state");
  await protection.ensureDirectory(stateDir);
  cleanups.push(dirs.cleanup);
  const values = new Map<string, string>(),
    audits: string[] = [],
    uploads: Buffer[] = [];
  let authorization: URL | undefined,
    writes = 0,
    allow = true,
    project = "project-1",
    stale = false,
    hold = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1"),
        chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/authorize") {
        authorization = url;
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-code");
        res.writeHead(302, { location: callback.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(body.toString());
        expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(
          authorization?.searchParams.get("code_challenge"),
        );
        res.end(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh" }));
        return;
      }
      expect(req.headers.authorization).toBe("Bearer fixture-access");
      if (url.pathname === "/profile") {
        res.end(JSON.stringify({ data: { id: "recipient", username: "fixture", name: "Fixture Owner" } }));
        return;
      }
      if (url.pathname === "/2/users/me") {
        res.end(JSON.stringify({ data: { id: "recipient", protected: false } }));
        return;
      }
      if (url.pathname === "/2/media/upload") {
        uploads.push(body);
        res.end(JSON.stringify({ data: { id: "media-1" } }));
        return;
      }
      if (url.pathname === "/2/tweets") {
        writes++;
        if (hold) return;
        if (stale) {
          res.writeHead(401);
          res.end("{}");
        } else res.end(JSON.stringify({ data: { id: "post-1" } }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.unshift(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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
  const accounts = await SocialAccountRuntime.open({
    stateDir,
    privateFiles: protection,
    audit: async () => {},
    secrets: async () => secrets,
    adapters: new Map([["x", fixtureOAuthAdapter("x", origin)]]),
    loopbackFixtures: true,
  });
  cleanups.unshift(() => accounts.close());
  await accounts.configure("x", "fixture-client");
  const flow = await accounts.connect("x");
  await fetch(flow.authorizationUrl);
  await waitFor(async () => accounts.list().accounts.some((a) => a.provider === "x" && a.state === "connected"));
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  cleanups.unshift(() => core.shutdown());
  const host = {
    stateDir,
    privateFiles: protection,
    core: () => core,
    project: () => project,
    accounts,
    authorizePublication: async () => {
      if (!allow) throw new Error("Entitlement or managed-channel protection unavailable");
    },
    audit: async (e: { state: string }) => {
      audits.push(e.state);
    },
    publisher: fixturePublisher(origin),
  };
  const runtime = await PublicationRuntime.open(host);
  cleanups.unshift(() => runtime.close());
  return {
    dirs,
    stateDir,
    runtime,
    accounts,
    values,
    audits,
    uploads,
    host,
    writes: () => writes,
    setAllow: (v: boolean) => {
      allow = v;
    },
    setProject: (v: string) => {
      project = v;
    },
    setHold: (value: boolean) => {
      hold = value;
    },
    expire: () => {
      stale = true;
    },
  };
}
const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("original immutable image")]);
const request = {
  provider: "x",
  accountId: "x:recipient",
  title: "Title",
  description: "Description",
  mediaPath: "image.png",
};
const confirmation = (id: string, nonce: string) => ({
  id,
  confirmation: nonce,
  title: "Edited",
  description: "Human-approved",
  privacy: "public",
  termsAccepted: true,
});
it("freezes source, previews exactly the protected bytes, consumes owner permit once and audits actual HTTP send", async () => {
  const f = await setup(),
    owner = {};
  await writeFile(path.join(f.dirs.workspace, "image.png"), image);
  const draft = await f.runtime.prepare(testContext, request);
  expect(f.writes()).toBe(0);
  await rename(path.join(f.dirs.workspace, "image.png"), path.join(f.dirs.workspace, ".env.future"));
  await writeFile(path.join(f.dirs.workspace, "image.png"), "agent substituted after prepare");
  const opened = f.runtime.openForOwner(owner, draft.id),
    preview = await f.runtime.preview(owner, { id: draft.id, offset: 0, length: 24576 });
  expect(Buffer.from(preview.data, "base64")).toEqual(image);
  expect(preview.sha256).toBe(draft.account.media!.sha256);
  const fields = confirmation(draft.id, opened.confirmation);
  expect(() => f.runtime.confirm({}, fields)).toThrow("confirmation");
  expect(f.runtime.confirm(owner, fields)).toEqual({ ok: true, id: draft.id, state: "queued" });
  expect(() => f.runtime.confirm(owner, fields)).toThrow("confirmation");
  await waitFor(async () => f.runtime.list(owner).publications[0]?.state === "published");
  expect(f.writes()).toBe(1);
  expect(f.uploads).toHaveLength(1);
  expect(f.uploads[0]!.includes(image)).toBe(true);
  expect(f.audits).toEqual(["pending_publication", "queued", "processing", "published"]);
  for (const file of ["publications.json", "social-accounts.json"])
    expect(await readFile(path.join(f.stateDir, file), "utf8")).not.toMatch(
      /fixture-access|fixture-refresh|fixture-code/,
    );
});
it("rejects missing privacy/disclosure, media/account substitution and owner-session replay before HTTP", async () => {
  const f = await setup(),
    owner = {};
  const draft = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined });
  const opened = f.runtime.openForOwner(owner, draft.id),
    fields = confirmation(draft.id, opened.confirmation);
  const { privacy: _, ...missing } = fields;
  void _;
  for (const input of [
    missing,
    { ...fields, commercial: true },
    { ...fields, accountId: "x:attacker" },
    { ...fields, mediaId: "other" },
    { ...fields, mediaPath: ".env" },
  ])
    expect(() => f.runtime.confirm(owner, input)).toThrow();
  expect(f.writes()).toBe(0);
  f.runtime.endOwnerSession(owner);
  expect(() => f.runtime.confirm(owner, fields)).toThrow("confirmation");
  await expect(f.runtime.prepare(testContext, { ...request, mediaId: "existing" })).rejects.toThrow();
});
it("rechecks snapshot hash, active project and fresh authorization at actual send; no silent retry", async () => {
  const f = await setup(),
    owner = {};
  await writeFile(path.join(f.dirs.workspace, "image.png"), image);
  const draft = await f.runtime.prepare(testContext, request),
    opened = f.runtime.openForOwner(owner, draft.id);
  const previewBefore = await f.runtime.preview(owner, { id: draft.id, offset: 0, length: 24576 });
  const blob = path.join(f.stateDir, "publication-media", draft.request.mediaId + ".media"),
    changed = Buffer.from(image);
  changed[changed.length - 1] = 0;
  await writeFile(blob, changed);
  const previewAfter = await f.runtime.preview(owner, { id: draft.id, offset: 0, length: 24576 });
  expect(previewAfter.data).toBe(previewBefore.data); // cached immutable preview; send still rehashes fresh disk bytes

  f.runtime.confirm(owner, confirmation(draft.id, opened.confirmation));
  await waitFor(async () => f.runtime.list(owner).publications[0]?.state === "failed");
  expect(f.writes()).toBe(0);
  expect(f.uploads).toHaveLength(0);
  const next = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined }),
    permit = f.runtime.openForOwner(owner, next.id);
  f.setAllow(false);
  f.runtime.confirm(owner, confirmation(next.id, permit.confirmation));
  await waitFor(async () => f.runtime.list(owner).publications.find((r) => r.id === next.id)?.state === "failed");
  expect(f.writes()).toBe(0);
  await expect(f.runtime.prepare(testContext, { ...request, mediaPath: undefined })).rejects.toThrow("protection");
  f.setAllow(true);
  const third = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined }),
    thirdPermit = f.runtime.openForOwner(owner, third.id);
  f.setProject("other-project");
  expect(() => f.runtime.confirm(owner, confirmation(third.id, thirdPermit.confirmation))).toThrow("project");
});
it("a platform 401 invalidates the account lease and clears credentials rather than retrying", async () => {
  const f = await setup(),
    owner = {};
  const draft = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined }),
    opened = f.runtime.openForOwner(owner, draft.id);
  f.expire();
  f.runtime.confirm(owner, confirmation(draft.id, opened.confirmation));
  await waitFor(async () => f.runtime.list(owner).publications[0]?.state === "failed");
  expect(f.writes()).toBe(1);
  expect(f.accounts.list().accounts.find((a) => a.provider === "x")?.state).toBe("reauth_required");
  expect(f.values.size).toBe(0);
});
it("restart loses confirmation permits, keeps pending frozen records, and needs a fresh owner open", async () => {
  const f = await setup(),
    owner = {};
  const draft = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined }),
    opened = f.runtime.openForOwner(owner, draft.id);
  await f.runtime.close();
  const restarted = await PublicationRuntime.open(f.host);
  cleanups.unshift(() => restarted.close());
  expect(() => restarted.confirm(owner, confirmation(draft.id, opened.confirmation))).toThrow("confirmation");
  const next = restarted.openForOwner(owner, draft.id);
  restarted.confirm(owner, confirmation(draft.id, next.confirmation));
  await waitFor(async () => restarted.list(owner).publications[0]?.state === "published");
  expect(f.writes()).toBe(1);
});
it("account disconnect and runtime shutdown abort in-flight HTTP delivery without retry", async () => {
  const f = await setup(),
    owner = {};
  const draft = await f.runtime.prepare(testContext, { ...request, mediaPath: undefined });
  const opened = f.runtime.openForOwner(owner, draft.id);
  f.setHold(true);
  f.runtime.confirm(owner, confirmation(draft.id, opened.confirmation));
  await waitFor(async () => f.writes() === 1);
  await f.accounts.disconnect("x");
  await waitFor(async () => f.runtime.list(owner).publications[0]?.state === "failed");
  expect(f.values.size).toBe(0);
  expect(f.writes()).toBe(1);
  await f.runtime.close();
  expect(() => f.runtime.openForOwner(owner, draft.id)).toThrow("owner");
  await expect(f.runtime.prepare(testContext, request)).rejects.toThrow("unavailable");
});
