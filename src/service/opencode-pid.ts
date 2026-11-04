/**
 * The PID file of CROT's own `opencode serve` (<stateDir>/opencode-bridge.pid): written when the bridge starts
 * the server and removed when it stops. A file left behind means CROT ended without stopping the server
 * (killed, crashed, power loss); the next start stops that server first, but only after checking that the
 * process still is that server (its command line ends in `serve --hostname 127.0.0.1 --port <port>` of the
 * recorded program), so a reused PID of another program is never touched.
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BridgePidRecord {
  readonly pid: number;
  readonly port: number;
  /** The program that was started (the `opencode` binary). */
  readonly command: string;
  readonly startedAt: string;
}
/** Reading and stopping another process (injectable for tests). */
export interface BridgeProcesses {
  /** Whether a process with this PID exists. */
  alive(pid: number): boolean;
  /** The command line of a process of this user, or undefined when it cannot be read. */
  commandLine(pid: number): Promise<string | undefined>;
  /** Stop the process and its descendants (forced after a short grace period on POSIX). */
  kill(pid: number): Promise<void>;
}

const run = (file: string, args: readonly string[], timeout: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });

export function nodeBridgeProcesses(platform: NodeJS.Platform = process.platform): BridgeProcesses {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  return {
    alive,
    async commandLine(pid) {
      if (platform === "linux")
        return (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => undefined))?.split("\0").join(" ");
      if (platform === "win32")
        return run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
          15_000,
        );
      return run("ps", ["-ww", "-o", "command=", "-p", String(pid)], 5_000);
    },
    async kill(pid) {
      if (platform === "win32") {
        await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 15_000);
        return;
      }
      // The bridge's server leads its own process group (POSIX launcher): the group goes, else the process.
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-pid, name);
        } catch {
          try {
            process.kill(pid, name);
          } catch {
            // Gone already.
          }
        }
      };
      signal("SIGTERM");
      for (let i = 0; i < 30 && alive(pid); i++) await delay(100);
      if (alive(pid)) signal("SIGKILL");
      for (let i = 0; i < 30 && alive(pid); i++) await delay(100);
    },
  };
}

const parse = (text: string): BridgePidRecord | undefined => {
  try {
    const value = JSON.parse(text) as Partial<BridgePidRecord>;
    const { pid, port, command } = value;
    if (!Number.isInteger(pid) || pid! <= 0 || !Number.isInteger(port) || port! <= 0 || port! > 65535) return undefined;
    if (typeof command !== "string" || !command || command.length > 4096) return undefined;
    return { pid: pid!, port: port!, command, startedAt: typeof value.startedAt === "string" ? value.startedAt : "" };
  } catch {
    return undefined;
  }
};

/** Whether a command line is the recorded server: its program and `serve --hostname 127.0.0.1 --port <port>`. */
export function isBridgeCommandLine(line: string, record: BridgePidRecord, platform: NodeJS.Platform): boolean {
  const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const words = fold(line.replace(/"/g, " ")).split(/\s+/).filter(Boolean).join(" ");
  const program = fold((platform === "win32" ? path.win32 : path.posix).basename(record.command));
  return words.includes(program) && words.endsWith(`serve --hostname 127.0.0.1 --port ${record.port}`);
}

export class BridgePidFile {
  constructor(
    readonly file: string,
    private readonly processes: BridgeProcesses,
    private readonly platform: NodeJS.Platform,
  ) {}
  async write(record: BridgePidRecord): Promise<void> {
    await writeFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
  /** Remove the file when it still names `pid` (a newer server's file stays). */
  async clear(pid: number | undefined): Promise<void> {
    const text = await readFile(this.file, "utf8").catch(() => undefined);
    if (text === undefined) return;
    const record = parse(text);
    if (!record || record.pid === pid) await rm(this.file, { force: true }).catch(() => undefined);
  }
  /** clear() while CROT exits (synchronous). */
  clearSync(pid: number | undefined): void {
    try {
      const record = parse(readFileSync(this.file, "utf8"));
      if (!record || record.pid === pid) unlinkSync(this.file);
    } catch {
      // No file.
    }
  }
  /** Stop the server a previous CROT left running; true when one was stopped. The file is removed. */
  async reap(): Promise<boolean> {
    const text = await readFile(this.file, "utf8").catch(() => undefined);
    if (text === undefined) return false;
    const record = parse(text);
    let stopped = false;
    if (record && record.pid !== process.pid && this.processes.alive(record.pid)) {
      const line = await this.processes.commandLine(record.pid);
      if (line && isBridgeCommandLine(line, record, this.platform)) {
        await this.processes.kill(record.pid);
        stopped = true;
      }
    }
    await rm(this.file, { force: true }).catch(() => undefined);
    return stopped;
  }
}
