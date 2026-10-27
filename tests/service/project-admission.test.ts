import path from "node:path";
import { access, mkdir, realpath } from "node:fs/promises";
import { expect, it } from "vitest";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { ProductRuntime } from "../../src/service/product-runtime.js";
import { createTestCore, makeTempDirs } from "../helpers.js";

it("serializes Free registrations, refuses the fourth before mkdir, and preserves existing projects after Pro loss", async () => {
  const dirs = await makeTempDirs();
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const stateDir = path.join(dirs.outside, "project-admission-state");
  const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
  let paid = false,
    runtime: ProductRuntime | undefined;
  const host = {
    stateDir,
    privateFiles,
    secrets: store,
    core: () => core,
    selectWorkspace: async () => {},
    unlimitedProjects: async () => paid,
  };
  try {
    runtime = await ProductRuntime.open(host);
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) => runtime!.request("projects.create", { path: path.join(dirs.outside, `free-${n}`) })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    const fourth = path.join(dirs.outside, "denied-before-mkdir");
    await expect(runtime.request("projects.create", { path: fourth })).rejects.toThrow("up to 3");
    await expect(access(fourth)).rejects.toThrow();
    const external = path.join(dirs.outside, "external");
    await mkdir(external);
    await expect(runtime.request("projects.open", { path: external })).rejects.toThrow("up to 3");
    paid = true;
    const extra = await runtime.request("projects.open", { path: external });
    expect(extra.ok).toBe(true);
    paid = false;
    // Opening an existing canonical project is not a new registration.
    await expect(runtime.request("projects.open", { path: await realpath(external) })).resolves.toMatchObject({
      ok: true,
    });
    await runtime.close();
    runtime = undefined;
    runtime = await ProductRuntime.open(host);
    expect((await runtime.request("projects.list", {})).projects).toHaveLength(4);
    await expect(runtime.request("projects.create", { path: fourth })).rejects.toThrow("up to 3");
    expect(core.status().confinement).toBeDefined();
  } finally {
    await runtime?.close();
    await core.shutdown();
    await dirs.cleanup();
  }
});
