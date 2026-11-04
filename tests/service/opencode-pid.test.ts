/**
 * The PID file of CROT's own `opencode serve`: a server a killed CROT left behind is stopped at the next start,
 * but only when the PID still is that server; the file never outlives the check.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BridgePidFile,
  isBridgeCommandLine,
  type BridgePidRecord,
  type BridgeProcesses,
} from "../../src/service/opencode-pid.js";
import { makeTempDirs } from "../helpers.js";

const record = (
  pid: number,
  command = "/home/o/.crot/opencode-runtime/node_modules/x/bin/opencode",
): BridgePidRecord => ({
  pid,
  port: 4096,
  command,
  startedAt: "2026-01-01T00:00:00.000Z",
});

describe("OpenCode bridge PID file", () => {
  it("recognizes only the recorded server's command line", () => {
    const r = record(10);
    expect(isBridgeCommandLine(`${r.command} serve --hostname 127.0.0.1 --port 4096 `, r, "linux")).toBe(true);
    // Another port, another program, or a command that merely mentions the server's arguments.
    expect(isBridgeCommandLine(`${r.command} serve --hostname 127.0.0.1 --port 4097`, r, "linux")).toBe(false);
    expect(isBridgeCommandLine("/usr/bin/vim serve --hostname 127.0.0.1 --port 4096", r, "linux")).toBe(false);
    expect(isBridgeCommandLine(`${r.command} serve --hostname 127.0.0.1 --port 4096 --debug`, r, "linux")).toBe(false);
    expect(isBridgeCommandLine("", r, "linux")).toBe(false);
    // Windows: quoted paths with spaces, case-insensitive.
    const w = record(11, "C:\\Users\\O\\AppData\\Local\\CROT\\opencode-runtime\\bin\\opencode.exe");
    expect(
      isBridgeCommandLine(
        '"C:\\Users\\O\\AppData\\Local\\CROT\\opencode-runtime\\bin\\OpenCode.exe" serve --hostname 127.0.0.1 --port 4096',
        w,
        "win32",
      ),
    ).toBe(true);
  });

  it("stops a verified server, never a reused PID of another program, and always removes the file", async () => {
    const dirs = await makeTempDirs();
    const file = path.join(dirs.outside, "opencode-bridge.pid");
    const killed: number[] = [];
    const lines = new Map<number, string>([
      [101, `${record(101).command} serve --hostname 127.0.0.1 --port 4096`],
      [102, "/usr/bin/python3 -m http.server 4096"],
    ]);
    const processes: BridgeProcesses = {
      alive: (pid) => lines.has(pid),
      commandLine: async (pid) => lines.get(pid),
      kill: async (pid) => {
        killed.push(pid);
      },
    };
    const pidFile = new BridgePidFile(file, processes, "linux");
    try {
      expect(await pidFile.reap()).toBe(false);
      await pidFile.write(record(101));
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record(101));
      expect(await pidFile.reap()).toBe(true);
      expect(killed).toEqual([101]);
      await expect(readFile(file, "utf8")).rejects.toThrow();
      for (const content of [
        JSON.stringify(record(102)), // the PID belongs to another program now
        JSON.stringify(record(103)), // the process is gone
        JSON.stringify({ ...record(process.pid) }), // CROT itself
        "not json",
        JSON.stringify({ pid: -1, port: 4096, command: "opencode" }),
      ]) {
        await writeFile(file, content);
        expect(await pidFile.reap()).toBe(false);
        await expect(readFile(file, "utf8")).rejects.toThrow();
      }
      expect(killed).toEqual([101]);
      // clear(): only the file of that server goes (a newer server's file stays).
      await pidFile.write(record(101));
      await pidFile.clear(999);
      expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(101);
      pidFile.clearSync(999);
      expect(JSON.parse(await readFile(file, "utf8")).pid).toBe(101);
      await pidFile.clear(101);
      await expect(readFile(file, "utf8")).rejects.toThrow();
      await pidFile.write(record(101));
      pidFile.clearSync(101);
      await expect(readFile(file, "utf8")).rejects.toThrow();
      await pidFile.clear(101);
      pidFile.clearSync(101);
    } finally {
      await dirs.cleanup();
    }
  });
});
