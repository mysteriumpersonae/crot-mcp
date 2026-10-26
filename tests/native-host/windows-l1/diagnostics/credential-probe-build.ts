/** SDK-built CredReadW caller, never prints credential bytes. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
export async function buildCredentialProbe() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-cred-probe-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await promisify(execFile)(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("tests/native-host/windows-l1/fixtures/build-credential-probe.ps1"),
        "-OutputDirectory",
        dir,
        "-Architecture",
        process.arch === "arm64" ? "ARM64" : "x64",
      ],
      { timeout: 120000 },
    );
    return { executable: path.join(dir, "credential-probe.exe"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
