/** Packaging composition fixture, not native-binary/signature/installation qualification. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it("desktop fixture carries prerequisites/legal/lockfile and refuses symlinked output without touching its target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crot-desktop-package-"));
  const script = path.resolve("scripts/package-desktop.mjs");
  const files: Record<string, string> = {
    "package.json": '{"name":"packaging-fixture","version":"0.0.0"}',
    "package-lock.json": '{"lockfileVersion":3}',
    "scripts/l1-install.sh": "# fixture only",
    "scripts/l1-components-win.ps1": "# fixture only",
    "scripts/build-windows-local-shim.ps1":
      'param([string]$OutputDirectory,[string]$Architecture)\nNew-Item -ItemType Directory -Force $OutputDirectory | Out-Null\n[IO.File]::WriteAllBytes((Join-Path $OutputDirectory "crot-local-shim.dll"), [byte[]](1,2,3))',
    "l1/native/crot-l1-init.c": "/* fixture only */",
    "native/fixture.txt": "fixture only; not a qualified native binary",
    "src/native-host/linux-l1/components.ts": "// fixture only",
    "docs/legal/README.md": "Pre-release legal drafts",
    "docs/legal/PRIVACY_POLICY.ru.md": "Проект политики",
    "docs/INSTALL.md": "No standalone installer",
    "docs/RELEASE-HARDENING.md": "External signing gates",
    "THIRD_PARTY_NOTICES.md": "Fixture notices",
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    await exec("git", ["init"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await mkdir(path.join(root, "dist-release"));
    await writeFile(path.join(root, "dist-release/release-identity.json"), '{"fixture":true}');
    await exec(process.execPath, [script], { cwd: root });
    const platforms: Partial<Record<NodeJS.Platform, string>> = { linux: "linux", darwin: "macos", win32: "windows" };
    const osName = platforms[process.platform];
    if (!osName) throw new Error("Unsupported package test platform");
    const target = path.join(
      root,
      "artifacts/downloads",
      `crot-${osName}.${process.platform === "win32" ? "zip" : "tar.gz"}`,
    );
    const digest = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    expect((await readFile(target + ".sha256", "utf8")).trim()).toBe(digest);
    const extracted = path.join(root, "extracted");
    await mkdir(extracted);
    if (process.platform === "win32") {
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path ${quote(target)} -DestinationPath ${quote(extracted)}`,
      ]);
    } else await exec("tar", ["-xzf", target, "-C", extracted]);
    expect(await readFile(path.join(extracted, "PACKAGE-PREREQUISITES.txt"), "utf8")).toContain(
      "NOT a standalone GUI installer",
    );
    for (const file of [
      "package-lock.json",
      "docs/legal/README.md",
      "docs/legal/PRIVACY_POLICY.ru.md",
      "THIRD_PARTY_NOTICES.md",
    ])
      expect(await readFile(path.join(extracted, file), "utf8")).toBe(files[file]);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel"), "keep");
    await rm(path.join(root, "artifacts"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "artifacts"), process.platform === "win32" ? "junction" : "dir");
    await expect(exec(process.execPath, [script], { cwd: root })).rejects.toThrow("unsafe output symlink");
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
