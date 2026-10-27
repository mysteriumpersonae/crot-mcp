/** Package a pinned build: invoke build:release -- --environment <public-config> first. */
import { validateOutput } from "./output-path.mjs";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
const platform = { linux: "linux", darwin: "macos", win32: "windows" }[process.platform];
if (!platform) throw new Error("Unsupported package platform");
const root = process.cwd(),
  output = path.join(root, "artifacts", "downloads");
const stage = path.join(root, "artifacts", "desktop-stage");
await validateOutput(root, stage);
await validateOutput(root, output);
const release = await validateOutput(root, path.join(root, "dist-release"));
await stat(path.join(release, "release-identity.json"));
// Full tracked tree is mandatory: this cannot silently package a partial MCP reconstruction.
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const required of [
  "package.json",
  "package-lock.json",
  "scripts/l1-install.sh",
  "scripts/l1-components-win.ps1",
  "l1/native/crot-l1-init.c",
  "src/native-host/linux-l1/components.ts",
])
  if (!tracked.includes(required)) throw new Error("Incomplete source tree: " + required);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "dist-release"), path.join(stage, "dist"), { recursive: true });
for (const file of tracked.filter(
  (f) =>
    /^(scripts\/|l1\/|native\/|docs\/legal\/)/.test(f) ||
    [
      "package.json",
      "package-lock.json",
      "src/native-host/linux-l1/components.ts",
      "THIRD_PARTY_NOTICES.md",
      "LICENSE",
      "docs/INSTALL.md",
      "docs/RELEASE-HARDENING.md",
    ].includes(f),
)) {
  await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
  await cp(path.join(root, file), path.join(stage, file));
}
if (platform === "windows") {
  if (process.arch !== "x64") throw new Error("Windows bundle is qualified for x64 only");
  const build = await validateOutput(root, path.join(root, "artifacts", "windows-shim"));
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(root, "scripts", "build-windows-local-shim.ps1"),
      "-OutputDirectory",
      build,
      "-Architecture",
      "x64",
    ],
    { stdio: "inherit" },
  );
  await cp(path.join(build, "crot-local-shim.dll"), path.join(stage, "native", "crot-local-shim.dll"));
}
await writeFile(
  path.join(stage, "PACKAGE-PREREQUISITES.txt"),
  "Operator-managed source/compiled bundle, NOT a standalone GUI installer.\n" +
    `Platform: ${platform}; architecture: ${process.arch}.\n` +
    "Provision Node 20/22, pinned npm runtime dependencies and qualified native L1 components before use.\n" +
    "Electron/tray runtime, native registration, vendor signing/notarization and installation smoke tests remain external gates.\n" +
    "See docs/INSTALL.md, docs/RELEASE-HARDENING.md and docs/legal/README.md.\n",
);
const file = "crot-" + platform + (platform === "windows" ? ".zip" : ".tar.gz"),
  target = path.join(output, file);
await rm(target, { force: true });
if (platform === "windows") {
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -Path " + quote(path.join(stage, "*")) + " -DestinationPath " + quote(target),
    ],
    { stdio: "inherit" },
  );
} else execFileSync("tar", ["-czf", target, "-C", stage, "."], { stdio: "inherit" });
const digest = createHash("sha256")
  .update(await readFile(target))
  .digest("hex");
await writeFile(target + ".sha256", digest + "\n");
await rm(stage, { recursive: true, force: true });
process.stdout.write(file + " sha256=" + digest + "\n");
