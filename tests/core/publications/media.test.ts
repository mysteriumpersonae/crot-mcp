/** File-identity/TOCTOU tests; OS-private ACL qualification has its own native platform suites. */
import { afterEach, expect, it } from "vitest";
import { link, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PublicationMedia } from "../../../src/core/publications/media.js";
import type { PrivateFileProtection } from "../../../src/core/platform/types.js";
import { createTestCore, makeTempDirs, testContext, linkDirectory } from "../../helpers.js";
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
    detail: "Trusted test fixture; not an OS ACL qualification",
  }),
};
const png = () => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture image")]);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
async function setup() {
  const dirs = await makeTempDirs();
  cleanups.push(dirs.cleanup);
  const dir = path.join(dirs.outside, "publication-media");
  return { dirs, dir, store: await PublicationMedia.open(dir, protection) };
}
it("owns input bytes, freezes metadata and verifies SHA-256 again after restart", async () => {
  const { dir, store } = await setup(),
    input = png(),
    expected = Buffer.from(input);
  const snapshot = await store.capture("project", "assets/picture.png", input);
  input.fill(0);
  snapshot.name = "mutated";
  const reopened = await PublicationMedia.open(dir, protection),
    verified = await reopened.verified(snapshot.id, "project");
  expect(verified.data).toEqual(expected);
  expect(verified.snapshot.name).toBe("picture.png");
  expect(verified.snapshot.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  verified.data.fill(0);
  expect((await reopened.verified(snapshot.id, "project")).data).toEqual(expected);
  expect(() => reopened.get(snapshot.id, "other-project")).toThrow("project");
});
it("rejects modified, replaced and hardlinked staging blobs before releasing bytes", async () => {
  const { dir, dirs, store } = await setup(),
    snapshot = await store.capture("p", "a.png", png());
  const file = path.join(dir, snapshot.id + ".media");
  const changed = png();
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await writeFile(file, changed);
  await expect(store.verified(snapshot.id, "p")).rejects.toThrow("SHA-256");
  await writeFile(file, png());
  await link(file, path.join(dirs.outside, "alias"));
  await expect(store.verified(snapshot.id, "p")).rejects.toThrow();
});
it("refuses unsafe staging directories/manifests and cannot treat unknown files as snapshots", async () => {
  const { dirs, dir } = await setup();
  const alias = path.join(dirs.workspace, "alias");
  await linkDirectory(dir, alias);
  await expect(PublicationMedia.open(alias, protection)).rejects.toThrow("directory");
  await writeFile(path.join(dir, "unexpected"), "private");
  await expect(PublicationMedia.open(dir, protection)).rejects.toThrow("entry");
  await expect(
    PublicationMedia.open(path.join(dirs.outside, "unprotected"), {
      ...protection,
      inspect: async () => ({ mechanism: "inherited-acl", ownerOnly: null, detail: "not enforced" }),
    }),
  ).rejects.toThrow("protection unavailable");
});
it("cleans orphan blobs from interrupted captures, but refuses missing committed media", async () => {
  const { dir, store } = await setup(),
    orphan = path.join(dir, randomUUID() + ".media");
  await writeFile(orphan, png());
  await PublicationMedia.open(dir, protection);
  await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  const snapshot = await store.capture("p", "a.png", png());
  await rename(path.join(dir, snapshot.id + ".media"), path.join(dir, randomUUID() + ".media"));
  await expect(PublicationMedia.open(dir, protection)).rejects.toThrow("missing");
});
it("accepts exactly 64 committed snapshots on restart, refuses the 65th, excludes active documents and secrets", async () => {
  const { dir, store } = await setup();
  for (let i = 0; i < 64; i++) await store.capture("p", `a${i}.png`, png());
  const reopened = await PublicationMedia.open(dir, protection);
  await expect(reopened.capture("p", "extra.png", png())).rejects.toThrow("capacity");
  for (const name of [".env", ".env.production", "x.pem", "x.KEY", "../x", ".git/x"])
    await expect(store.capture("p", name, png())).rejects.toThrow();
  await expect(store.capture("p", "active.svg", Buffer.from("<svg/onload=alert(1)>"))).rejects.toThrow("supported");
});
it("captures through checked Core reads, rejects secret/link sources, and survives live atomic-save replacement", async () => {
  const { dirs, store } = await setup();
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  cleanups.unshift(() => core.shutdown());
  const source = path.join(dirs.workspace, "image.png"),
    original = png();
  await writeFile(source, original);
  const artifact = await core.filesystem.capturePublicationMedia(testContext, "image.png");
  const snapshot = await store.capture("p", "image.png", artifact.data);
  await writeFile(path.join(dirs.workspace, "new.png"), Buffer.from("substituted secret"));
  await rename(source, path.join(dirs.workspace, ".env.future"));
  await rename(path.join(dirs.workspace, "new.png"), source);
  expect((await store.verified(snapshot.id, "p")).data).toEqual(original);
  for (const name of [".env.future", ".env.new", "secret.pem", "future.key"])
    await expect(core.filesystem.capturePublicationMedia(testContext, name)).rejects.toThrow();
  await link(source, path.join(dirs.workspace, "alias.png"));
  await expect(core.filesystem.capturePublicationMedia(testContext, "alias.png")).rejects.toThrow();
});
it("reserves staging as secret state: generic Core tools cannot read it even in Full Control", async () => {
  const { dirs, dir, store } = await setup();
  const { stateSecretPaths } = await import("../../../src/service/secrets/store.js");
  const snapshot = await store.capture("p", "image.png", png());
  const core = await createTestCore(
    { workspace: { root: dirs.outside }, permissions: { mode: "full_control" } },
    undefined,
    { secretPaths: stateSecretPaths(dirs.outside) },
  );
  cleanups.unshift(() => core.shutdown());
  await expect(
    core.filesystem.readFile(testContext, { path: path.join(dir, snapshot.id + ".media") }),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  await expect(
    core.filesystem.capturePublicationMedia(testContext, "publication-media/" + snapshot.id + ".media"),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
});
it("honors a mandatory deny rule for capture, even with Full Control enabled", async () => {
  const { dirs } = await setup();
  const { RuntimePermissionState } = await import("../../../src/core/permissions/runtime.js");
  const runtimePermissions = new RuntimePermissionState();
  runtimePermissions.replace({
    strict: false,
    rules: [{ operation: "filesystem.capture_publication_media", state: "deny" }],
  });
  const core = await createTestCore(
    { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
    undefined,
    { runtimePermissions },
  );
  cleanups.unshift(() => core.shutdown());
  await writeFile(path.join(dirs.workspace, "image.png"), png());
  await expect(core.filesystem.capturePublicationMedia(testContext, "image.png")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
