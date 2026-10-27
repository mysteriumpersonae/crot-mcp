import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
const exec = promisify(execFile);
const outputs: string[] = [];
afterAll(async () => {
  for (const o of outputs) await rm(o, { recursive: true, force: true });
});
describe("WP-35 extension store package", () => {
  it("validates MV3 and emits reproducible zip plus SHA-256", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "crot-extension-package-"));
    outputs.push(out);
    const code = `import {packageExtension} from ${JSON.stringify(new URL("../../scripts/package-extension.mjs", import.meta.url).href)}; console.log(JSON.stringify(await packageExtension({repo:${JSON.stringify(path.resolve("."))},outDir:${JSON.stringify(path.join(out, "output"))}})))`;
    const one = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", code])).stdout);
    const first = await readFile(one.target);
    const two = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", code])).stdout);
    const second = await readFile(two.target);
    expect(first.equals(second)).toBe(true);
    expect(createHash("sha256").update(first).digest("hex")).toBe(one.digest);
    expect(one.files).toContain("manifest.json");
    expect(one.files.some((f: string) => f.startsWith("dist/"))).toBe(true);
    expect(one.files).toHaveLength(35);
    expect(one.files.some((f: string) => /(?:test|fixture|node_modules|\.map$|\.ts$|source\.json)/.test(f))).toBe(
      false,
    );
    for (const size of [16, 32, 48, 128]) expect(one.files).toContain(`icons/icon${size}.png`);
    expect(await readFile(`${one.target}.sha256`, "utf8")).toContain(one.digest);
  });
});

it("rejects stale/dev modules, unsafe manifest/CSP, malformed icons and unsafe output paths", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crot-extension-fixture-"));
  outputs.push(repo);
  await cp(path.resolve("extension"), path.join(repo, "extension"), { recursive: true });
  const script = new URL("../../scripts/package-extension.mjs", import.meta.url).href;
  const run = (outDir = path.join(repo, "artifacts", "store")) =>
    exec(process.execPath, [
      "--input-type=module",
      "-e",
      `import {packageExtension} from ${JSON.stringify(script)}; await packageExtension({repo:${JSON.stringify(repo)},outDir:${JSON.stringify(outDir)}});`,
    ]);
  await run();
  const extra = path.join(repo, "extension", "dist", "test-hook.js");
  await writeFile(extra, "globalThis.testHook = true;");
  await expect(run()).rejects.toThrow("reviewed production modules");
  await rm(extra);
  const file = path.join(repo, "extension", "manifest.json");
  const original = await readFile(file, "utf8"),
    manifest = JSON.parse(original);
  for (const patch of [
    { externally_connectable: { matches: ["https://example.com/*"] } },
    { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } },
    { background: { type: "module", service_worker: "dist/test-hook.js" } },
    { icons: { ...manifest.icons, "16": "icons/icon32.png" } },
  ]) {
    await writeFile(file, JSON.stringify({ ...manifest, ...patch }));
    await expect(run()).rejects.toThrow();
  }
  await writeFile(file, original);
  await writeFile(path.join(repo, "extension", "icons", "icon16.png"), Buffer.alloc(40));
  await expect(run()).rejects.toThrow("invalid store icon");
  await expect(run(path.join(repo, "src"))).rejects.toThrow("unsafe output directory");
});
