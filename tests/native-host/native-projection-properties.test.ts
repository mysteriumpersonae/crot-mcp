/** AD-57 real-filesystem counterexamples, NOT sandbox/native admission tests. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, link, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { isProjectSecretName } from "../../src/core/permissions/project-secrets.js";
import { isWindows, makeTempDirs } from "../helpers.js";

async function projection() {
  const dirs = await makeTempDirs();
  try {
    const target = path.join(dirs.outside, "projection");
    await mkdir(target);
    const source = path.join(dirs.workspace, "public.txt"),
      projected = path.join(target, "public.txt");
    await writeFile(source, "public-before");
    await link(source, projected);
    // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Preserve all bits.
    const a = await stat(source, { bigint: true }),
      b = await stat(projected, { bigint: true });
    expect(a.dev).toBe(b.dev);
    expect(a.ino).toBe(b.ino);
    expect(a.nlink).toBe(2n);
    return { dirs, target, source, projected };
  } catch (error) {
    await dirs.cleanup();
    throw error;
  }
}

it("hardlinks perform real in-place original writes before teardown, without copy-back", async () => {
  const p = await projection();
  try {
    await writeFile(p.projected, "direct-after");
    expect(await readFile(p.source, "utf8")).toBe("direct-after");
    expect((await stat(p.source, { bigint: true })).ino).toBe((await stat(p.projected, { bigint: true })).ino);
  } finally {
    await p.dirs.cleanup();
  }
});

it("projected atomic save breaks direct original-file identity", async () => {
  const p = await projection();
  try {
    const temporary = path.join(p.target, "save.tmp");
    await writeFile(temporary, "atomic-after");
    await rename(temporary, p.projected);
    expect(await readFile(p.projected, "utf8")).toBe("atomic-after");
    expect(await readFile(p.source, "utf8")).toBe("public-before");
    expect((await stat(p.source, { bigint: true })).ino).not.toBe((await stat(p.projected, { bigint: true })).ino);
  } finally {
    await p.dirs.cleanup();
  }
});

it("host atomic replacement leaves the projection writing the detached old inode", async () => {
  const p = await projection();
  try {
    const temporary = path.join(p.dirs.workspace, "host.tmp");
    await writeFile(temporary, "host-replaced");
    await rename(temporary, p.source);
    await writeFile(p.projected, "detached-write");
    expect(await readFile(p.source, "utf8")).toBe("host-replaced");
    expect(await readFile(p.projected, "utf8")).toBe("detached-write");
  } finally {
    await p.dirs.cleanup();
  }
});

it("a stale public hardlink exposes source inode reclassified as a future secret", async () => {
  const p = await projection();
  try {
    const secret = path.join(p.dirs.workspace, ".env.future");
    expect(isProjectSecretName(path.basename(secret))).toBe(true);
    await rename(p.source, secret);
    await writeFile(secret, "synthetic-future-canary");
    // No retained read handle is needed: a NEW open through the stale public
    // hardlink reads the new secret. Source directory visibility is irrelevant.
    expect(await readFile(p.projected, "utf8")).toBe("synthetic-future-canary");
  } finally {
    await p.dirs.cleanup();
  }
});

it("finite stubs do not intercept a new secret create/open before watcher enforcement", async () => {
  const p = await projection();
  try {
    await writeFile(path.join(p.target, ".env"), "", { mode: 0 });
    const secret = path.join(p.target, "new-unlisted-private.key");
    expect(isProjectSecretName(path.basename(secret))).toBe(true);
    // A deliberately held observer boundary is deterministic, not a timing
    // benchmark. An async watcher cannot execute before this OS open returns.
    const handle = await open(secret, "wx+", 0o600);
    try {
      await handle.writeFile("synthetic-created-canary");
      await handle.sync();
      expect(await readFile(secret, "utf8")).toBe("synthetic-created-canary");
    } finally {
      await handle.close();
    }
  } finally {
    // Node's Windows cleanup may need to remove the owned read-only stub.
    await chmod(path.join(p.target, ".env"), 0o600).catch(() => undefined);
    await p.dirs.cleanup();
  }
});

it.runIf(!isWindows)("POSIX hardlink chmod affects the source and owner can undo a 0000 stub", async () => {
  const p = await projection();
  try {
    await chmod(p.projected, 0o400);
    expect((await stat(p.source)).mode & 0o777).toBe(0o400);
    await chmod(p.projected, 0o600);
    expect((await stat(p.source)).mode & 0o777).toBe(0o600);
    const stub = path.join(p.target, ".env.unlisted");
    await writeFile(stub, "", { mode: 0 });
    await chmod(stub, 0o600);
    await writeFile(stub, "owner-can-undo-mode");
    expect(await readFile(stub, "utf8")).toBe("owner-can-undo-mode");
  } finally {
    await chmod(p.source, 0o600).catch(() => undefined);
    await p.dirs.cleanup();
  }
});

it.runIf(isWindows)("NTFS hardlink DACL changes affect the source, not an independent projected ACL", async () => {
  const p = await projection();
  try {
    const ps = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = await promisify(execFile)(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference='Stop'
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$source=$env:CROT_AD57_SOURCE
$projected=$env:CROT_AD57_PROJECTED
$before=(Get-Acl -LiteralPath $source).Sddl
$acl=Get-Acl -LiteralPath $projected
# Synthetic exact package SID, no existing package/profile is adopted.
$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-15-2-121212-232323-343434-454545-565656-676767-787878')
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadData,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $projected -AclObject $acl
$after=(Get-Acl -LiteralPath $source).Sddl
$other=(Get-Acl -LiteralPath $projected).Sddl
@{sourceChanged=($before -ne $after);sameSecurity=($after -eq $other)} | ConvertTo-Json -Compress
`,
      ],
      {
        env: { ...process.env, CROT_AD57_SOURCE: p.source, CROT_AD57_PROJECTED: p.projected },
        timeout: 15000,
        maxBuffer: 8192,
        windowsHide: true,
      },
    );
    expect(JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim())).toEqual({
      sourceChanged: true,
      sameSecurity: true,
    });
    expect((await stat(p.source, { bigint: true })).ino).toBe((await stat(p.projected, { bigint: true })).ino);
  } finally {
    await p.dirs.cleanup();
  }
});
