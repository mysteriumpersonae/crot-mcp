/**
 * Local OpenCode: CROT's own `opencode serve` (the bridge: random password, 127.0.0.1, stopped with CROT, an
 * owner's unprotected server reused), OpenCode Zen through it without a key, the owner's OpenCode key with
 * OpenCode's session headers, free models through local OpenCode even with a key, OpenCode 2 (its new server API), and
 * the managed server of an earlier OpenCode workspace connection. A fake OpenCode server (Node) stands in for the real
 * one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { CORE_VERSION } from "../../src/core/crot-core.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import {
  basicAuthorization,
  lastOutputLine,
  olderThan,
  OPENCODE_MIN_VERSION,
  OpenCodeBridge,
  type OpenCodeBridgeOptions,
} from "../../src/service/opencode-bridge.js";
import {
  OPENCODE_RUNTIME_VERSION,
  runtimePackages,
  type OpenCodeInstallHost,
} from "../../src/service/opencode-runtime.js";
import { fakeRegistry, tgz } from "../fixtures/opencode-registry.js";
import { OPENCODE_FREE_MODELS } from "../../src/service/chat-runtime.js";
import { ProductRuntime, type ProductHost } from "../../src/service/product-runtime.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { createTestCore, isAlive, makeTempDirs, waitFor } from "../helpers.js";

const ZEN = "OpenCode (Free & Zen)";
const FAKE = fileURLToPath(new URL("../fixtures/fake-opencode.mjs", import.meta.url));
const ENV = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
async function healthStatus(url: string, authorization?: string): Promise<number | "down"> {
  try {
    return (await fetch(`${url}/global/health`, { headers: authorization ? { authorization } : {} })).status;
  } catch {
    return "down";
  }
}
interface Logged {
  method: string;
  path: string;
  directory?: string;
  body?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const readLog = async (file: string): Promise<Logged[]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Logged);

/** The fake server started by hand: the owner's own `opencode serve` (`--fake-v2`: OpenCode 2). */
const external: ChildProcess[] = [];
async function ownerServer(port: number, password?: string, flags: string[] = []): Promise<void> {
  const child = spawn(process.execPath, [FAKE, ...flags, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...ENV, ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}) },
    stdio: "ignore",
  });
  external.push(child);
  const auth = password ? basicAuthorization("opencode", password) : undefined;
  await waitFor(async () => (await healthStatus(`http://127.0.0.1:${port}`, auth)) === 200, 10_000);
}
afterEach(() => {
  for (const child of external.splice(0)) child.kill();
});

/** Bridge options of the tests: the fake server instead of the `opencode` binary, on a free port. */
async function fakeOptions(
  dir: string,
): Promise<Omit<OpenCodeBridgeOptions, "directory" | "port"> & { log: string; mode: string; port: number }> {
  const platform = await createNodePlatform({ startupPath: "inherited" });
  const log = path.join(dir, "opencode-log.jsonl"),
    mode = path.join(dir, "opencode-mode.txt"),
    home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  return {
    log,
    mode,
    local: { env: { XDG_DATA_HOME: path.join(dir, "data") }, home, platform: process.platform },
    env: { ...ENV, FAKE_OPENCODE_LOG: log, FAKE_OPENCODE_MODE_FILE: mode },
    launch: (command, args, { cwd, env }) =>
      platform.launcher.launch({ file: command, args, display: command }, { cwd, env, stdin: false }),
    command: async () => ({ command: process.execPath, args: [FAKE] }),
    port: await freePort(),
  };
}

describe("OpenCode bridge", () => {
  it("starts opencode serve on 127.0.0.1 with a random password, once, and stops it", async () => {
    const dirs = await makeTempDirs();
    const records: string[] = [];
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const bridge = new OpenCodeBridge({ ...options, directory, record: (e, o) => records.push(`${e}:${o}`) });
    try {
      expect(await bridge.status()).toEqual({ installed: true });
      const [server, again] = await Promise.all([bridge.ensure(), bridge.ensure()]);
      expect(again).toBe(server);
      expect(server).toMatchObject({
        url: `http://127.0.0.1:${options.port}`,
        managed: true,
        username: "opencode",
        version: "0.0.0-fake",
      });
      expect(server.password).toMatch(/^[\w-]{32}$/);
      expect(await healthStatus(server.url)).toBe(401);
      expect(await healthStatus(server.url, basicAuthorization("opencode", server.password!))).toBe(200);
      expect(await bridge.ensure()).toBe(server);
      const status = await bridge.status();
      expect(status).toEqual({
        installed: true,
        server: { url: server.url, managed: true, version: "0.0.0-fake", source: "owner" },
      });
      expect(JSON.stringify(status)).not.toContain(server.password);
      expect(await bridge.stop()).toBe(true);
      expect(bridge.current()).toBeUndefined();
      expect(await healthStatus(server.url)).toBe("down");
      expect(await bridge.stop()).toBe(false);
      expect(records).toEqual(["start:applied", "stop:applied"]);
      // A new password every start.
      const next = await bridge.ensure();
      expect(next.password).not.toBe(server.password);
      await bridge.close();
      expect(await healthStatus(next.url)).toBe("down");
      await expect(bridge.ensure()).rejects.toThrow("closed");
    } finally {
      await bridge.close();
      await dirs.cleanup();
    }
  });

  it("uses the owner's unprotected server on the port and never stops it; a protected one is left alone", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const owner = `http://127.0.0.1:${options.port}`;
    const bridge = new OpenCodeBridge({ ...options, directory });
    try {
      await ownerServer(options.port);
      expect(await bridge.status()).toEqual({
        installed: true,
        server: { url: owner, managed: false, version: "0.0.0-fake" },
      });
      const server = await bridge.ensure();
      expect(server).toEqual({ url: owner, managed: false, version: "0.0.0-fake" });
      expect(await bridge.stop()).toBe(false);
      expect(await healthStatus(owner)).toBe(200);
      external.splice(0).forEach((c) => c.kill());
      await waitFor(async () => (await healthStatus(owner)) === "down");

      // The port is taken by a protected server: CROT starts its own on another port.
      await ownerServer(options.port, "owner-password");
      const own = await bridge.ensure();
      expect(own.managed).toBe(true);
      expect(own.url).not.toBe(owner);
      expect(await healthStatus(owner, basicAuthorization("opencode", "owner-password"))).toBe(200);
      expect(await bridge.stop()).toBe(true);
      expect(await healthStatus(owner, basicAuthorization("opencode", "owner-password"))).toBe(200);
    } finally {
      await bridge.close();
      await dirs.cleanup();
    }
  });

  it("reports a missing OpenCode, refuses while starting processes is denied and a server that exits", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const records: string[] = [];
    const reason = async (bridge: OpenCodeBridge) => {
      const error = await bridge.ensure().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CrotError);
      return { code: (error as CrotError).code, reason: (error as CrotError).details?.reason };
    };
    const missing = new OpenCodeBridge({ ...options, directory, command: async () => undefined });
    const denied = new OpenCodeBridge({ ...options, directory, allowed: () => false });
    const exits = new OpenCodeBridge({
      ...options,
      directory,
      command: async () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
      record: (e, o) => records.push(`${e}:${o}`),
    });
    try {
      expect(await missing.status()).toEqual({ installed: false });
      expect(await reason(missing)).toEqual({ code: "NOT_FOUND", reason: "opencode_not_installed" });
      expect(await reason(denied)).toEqual({ code: "PERMISSION_DENIED", reason: "opencode_refused" });
      expect(await reason(exits)).toEqual({ code: "OPERATION_FAILED", reason: "opencode_start_failed" });
      // Once more on another port when the server exits at once (the port may have been taken in between).
      expect(records).toEqual(["start:failed", "start:failed"]);
      expect(exits.current()).toBeUndefined();
      // Why, until a start succeeds: the program and its exit code.
      expect(await exits.status()).toEqual({
        installed: true,
        problem: { code: "OPENCODE_START_FAILED", source: "owner", detail: `${process.execPath}: exited with code 3` },
      });
    } finally {
      await Promise.all([missing.close(), denied.close(), exits.close()]);
      await dirs.cleanup();
    }
  });

  it("stops the server a killed CROT left behind (PID file) before its own starts, never another program", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const pidFile = path.join(dirs.outside, "opencode-bridge.pid");
    const url = `http://127.0.0.1:${options.port}`;
    const records: string[] = [];
    // What a killed CROT leaves: its server running on (own process group, unprotected now) and the PID file.
    const leftover = spawn(
      process.execPath,
      [FAKE, "serve", "--hostname", "127.0.0.1", "--port", String(options.port)],
      {
        detached: true,
        stdio: "ignore",
        env: ENV,
      },
    );
    external.push(leftover);
    await waitFor(async () => (await healthStatus(url)) === 200, 10_000);
    await writeFile(
      pidFile,
      JSON.stringify({ pid: leftover.pid, port: options.port, command: process.execPath, startedAt: "" }),
    );
    const bridge = new OpenCodeBridge({ ...options, directory, pidFile, record: (e, o) => records.push(`${e}:${o}`) });
    let other: ChildProcess | undefined;
    try {
      // Not taken for the owner's own server: the leftover goes, and CROT's new server gets the port.
      const server = await bridge.ensure();
      expect(server).toMatchObject({ url, managed: true });
      expect(records).toEqual(["reap:applied", "start:applied"]);
      await waitFor(() => !isAlive(leftover.pid!), 10_000);
      const written = JSON.parse(await readFile(pidFile, "utf8")) as { pid: number; port: number; command: string };
      expect(written).toMatchObject({ port: options.port, command: process.execPath });
      expect(written.pid).not.toBe(leftover.pid);
      expect(isAlive(written.pid)).toBe(true);
      // Stopped by CROT: the file goes with the server.
      expect(await bridge.stop()).toBe(true);
      await expect(readFile(pidFile, "utf8")).rejects.toThrow();

      // The recorded PID now belongs to another program: it is left alone; the stale file goes.
      other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      external.push(other);
      await writeFile(pidFile, JSON.stringify({ pid: other.pid, port: options.port, command: process.execPath }));
      const next = new OpenCodeBridge({ ...options, directory, pidFile });
      expect(await next.reap()).toBe(false);
      await next.close();
      expect(isAlive(other.pid!)).toBe(true);
      await expect(readFile(pidFile, "utf8")).rejects.toThrow();
    } finally {
      await bridge.close();
      await dirs.cleanup();
    }
  }, 60_000);

  it("starts the OpenCode that CROT installed when the owner has none, with its own folders", async () => {
    const dirs = await makeTempDirs();
    const { command: _command, ...options } = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const home = path.join(dirs.outside, "opencode-runtime", "home");
    const installed = path.join(dirs.outside, "opencode-runtime", "bin", "opencode");
    let binary: string | undefined;
    const bridge = new OpenCodeBridge({ ...options, directory, runtime: { binary: async () => binary, home } });
    try {
      expect(await bridge.status()).toEqual({ installed: false });
      binary = installed;
      expect(await bridge.command()).toEqual({
        command: installed,
        args: [],
        source: "crot",
        env: {
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
        },
      });
      expect(await bridge.status()).toEqual({ installed: true });
    } finally {
      await bridge.close();
      await dirs.cleanup();
    }
  });

  it("says why the owner's OpenCode did not start: too old, exited, no answer", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const owner = (flag: string) => async () => ({ command: process.execPath, args: [FAKE, flag] });
    const failure = async (bridge: OpenCodeBridge) => {
      const error = await bridge.ensure().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CrotError);
      return (error as CrotError).details;
    };
    // OpenCode 0.x answers without /global/health: its version, and that CROT needs 1.0 or newer.
    const old = new OpenCodeBridge({ ...options, directory, command: owner("--fake-old") });
    // An npm installation without its postinstall script: the exit code and OpenCode's last error line.
    const crash = new OpenCodeBridge({ ...options, directory, command: owner("--fake-crash") });
    // A server that never gets healthy: the wait, its last answer and its last error line.
    const stuck = new OpenCodeBridge({
      ...options,
      directory,
      command: owner("--fake-unhealthy"),
      readyTimeoutMs: 2000,
    });
    try {
      const tooOld = `${process.execPath} 0.15.31: CROT needs OpenCode ${OPENCODE_MIN_VERSION} or newer`;
      expect(await failure(old)).toMatchObject({
        stage: "local",
        reason: "opencode_too_old",
        source: "owner",
        version: "0.15.31",
        detail: tooOld,
      });
      expect(await old.status()).toEqual({
        installed: true,
        problem: { code: "OPENCODE_TOO_OLD", source: "owner", version: "0.15.31", detail: tooOld },
      });
      expect(await failure(crash)).toMatchObject({
        reason: "opencode_start_failed",
        source: "owner",
        detail: `${process.execPath}: exited with code 1 — Error: opencode-ai's postinstall script was not run.`,
      });
      expect(await failure(stuck)).toMatchObject({
        reason: "opencode_start_failed",
        detail: `${process.execPath}: no answer within 2 s, last answer HTTP 503 — Error: database is locked`,
      });
      for (const bridge of [old, crash, stuck]) expect(bridge.current()).toBeUndefined();
    } finally {
      await Promise.all([old.close(), crash.close(), stuck.close()]);
      await dirs.cleanup();
    }
  }, 60_000);

  it("falls back to the copy CROT installed when the owner's OpenCode does not start", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const home = path.join(dirs.outside, "opencode-runtime", "home");
    const starts = path.join(dirs.outside, "starts.jsonl");
    const env = { ...options.env, FAKE_OPENCODE_STARTS: starts };
    const started = async () =>
      (await readFile(starts, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { flags: string[]; xdg: Record<string, string | null> });
    const fake = (flag: string) => async () => ({ command: process.execPath, args: [FAKE, flag] });
    const records: string[] = [];
    // The owner's OpenCode 0.x, then CROT's copy (its own config, data, state and cache folders).
    const bridge = new OpenCodeBridge({
      ...options,
      env,
      directory,
      command: fake("--fake-old"),
      runtime: { binary: async () => undefined, home },
      runtimeCommand: fake("--fake-crot"),
      record: (e, o) => records.push(`${e}:${o}`),
    });
    // Both fail: the copy CROT installed is the one to reinstall.
    const broken = new OpenCodeBridge({
      ...options,
      env,
      directory,
      command: fake("--fake-old"),
      runtime: { binary: async () => undefined, home },
      runtimeCommand: fake("--fake-crash"),
    });
    try {
      const error = await broken.ensure().catch((e: unknown) => e);
      expect((error as CrotError).details).toMatchObject({ reason: "opencode_start_failed", source: "crot" });
      expect((await broken.status()).problem).toEqual({
        code: "OPENCODE_START_FAILED",
        source: "crot",
        detail: `${process.execPath}: exited with code 1 — Error: opencode-ai's postinstall script was not run.`,
      });

      const server = await bridge.ensure();
      expect(server).toMatchObject({ managed: true, source: "crot" });
      expect(records).toEqual(["start:failed", "start:applied"]);
      // While it runs, no problem: the route says which OpenCode serves, and why the owner's own is not used.
      const ownerProblem = {
        code: "OPENCODE_TOO_OLD",
        source: "owner",
        version: "0.15.31",
        detail: `${process.execPath} 0.15.31: CROT needs OpenCode 1.0.0 or newer`,
      };
      expect(server.ownerProblem).toEqual(ownerProblem);
      expect(await bridge.status()).toEqual({
        installed: true,
        server: { url: server.url, managed: true, version: "0.0.0-fake", source: "crot" },
        ownerProblem,
      });
      const xdg = {
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      };
      const crot = (await started()).filter((s) => s.flags.includes("--fake-crot"));
      expect(crot.map((s) => s.xdg)).toEqual([xdg]);
      for (const folder of Object.values(xdg)) expect((await stat(folder)).isDirectory()).toBe(true);
      // The owner's OpenCode keeps its own folders.
      for (const s of (await started()).filter((s) => s.flags.includes("--fake-old")))
        expect(Object.values(s.xdg)).not.toContain(xdg.XDG_CONFIG_HOME);
      // Next time the owner's unchanged OpenCode is not tried again.
      expect(await bridge.stop()).toBe(true);
      const before = (await started()).length;
      expect((await bridge.ensure()).source).toBe("crot");
      expect((await started()).slice(before).map((s) => s.flags)).toEqual([["--fake-crot"]]);
      expect((await bridge.status()).ownerProblem).toEqual(ownerProblem);
    } finally {
      await Promise.all([bridge.close(), broken.close()]);
      await dirs.cleanup();
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "tries every OpenCode of the owner, each with its own folder first on PATH, before CROT's copy",
    async () => {
      const dirs = await makeTempDirs();
      const { command: _command, ...options } = await fakeOptions(dirs.outside);
      const directory = path.join(dirs.outside, "opencode-chat");
      const starts = path.join(dirs.outside, "starts.jsonl");
      const script = async (dir: string, flag: string) => {
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, "opencode");
        await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${flag} "$@"\n`);
        await chmod(file, 0o755);
        return file;
      };
      // A broken npm installation on PATH, then a working one of a Node version manager (nvm), whose folder only
      // the owner's shell puts on PATH (CROT started from the desktop does not get it).
      const broken = path.join(dirs.outside, "broken", "bin"),
        nvm = path.join(options.local.home, ".nvm", "versions", "node", "v22.11.0", "bin");
      const first = await script(broken, "--fake-crash"),
        second = await script(nvm, "");
      await script(path.join(options.local.home, ".nvm", "versions", "node", "v18.20.0", "bin"), "--fake-old");
      const alias = path.join(dirs.outside, "alias");
      await symlink(broken, alias);
      const bridge = new OpenCodeBridge({
        ...options,
        env: { ...options.env, FAKE_OPENCODE_STARTS: starts },
        local: { ...options.local, env: { ...options.local.env, PATH: `${broken}:${alias}` } },
        directory,
        runtime: { binary: async () => undefined },
      });
      try {
        const own = (await bridge.commands()).filter((c) => c.command.startsWith(dirs.outside));
        // Newest Node version first; a folder on PATH under a second name (a link) counts once.
        expect(own.map((c) => [c.command, c.source])).toEqual([
          [first, "owner"],
          [second, "owner"],
          [path.join(options.local.home, ".nvm", "versions", "node", "v18.20.0", "bin", "opencode"), "owner"],
        ]);
        expect(own[1]!.env?.PATH).toBe(`${nvm}${path.delimiter}${options.env.PATH}`);
        const server = await bridge.ensure();
        expect(server).toMatchObject({ managed: true, source: "owner" });
        const lines = (await readFile(starts, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { flags: string[]; path: string });
        // The broken one first (its exit is retried once on another port), then the working one.
        expect([...new Set(lines.map((l) => l.path))]).toEqual([broken, nvm]);
        expect(lines.at(-1)).toMatchObject({ flags: [], path: nvm });
      } finally {
        await bridge.close();
        await dirs.cleanup();
      }
    },
    60_000,
  );

  it("recognizes OpenCode 2 by /api/info: its own server, the owner's unprotected one, never a protected one", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const directory = path.join(dirs.outside, "opencode-chat");
    const v2 = async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] });
    const bridge = new OpenCodeBridge({ ...options, directory, command: v2 });
    const port = await freePort();
    const other = new OpenCodeBridge({ ...options, port, directory, command: v2 });
    try {
      // OpenCode 2's web app answers /global/health with a page: CROT asks /api/info with its password.
      const server = await bridge.ensure();
      expect(server).toMatchObject({ managed: true, source: "owner", api: 2, version: "2.2.5" });
      expect(server.url).toBe(`http://127.0.0.1:${options.port}`);
      expect(await bridge.status()).toEqual({
        installed: true,
        server: { url: server.url, managed: true, version: "2.2.5", api: 2, source: "owner" },
      });
      expect((await readLog(options.log)).some((l) => l.method === "GET" && l.path === "/api/info")).toBe(true);
      expect(await bridge.stop()).toBe(true);
      // The owner's OpenCode 2 with a password on the port: its page is no answer, so it is left alone.
      await ownerServer(options.port, "owner-secret", ["--fake-v2"]);
      const own = await bridge.ensure();
      expect(own).toMatchObject({ managed: true, api: 2 });
      expect(own.url).not.toBe(`http://127.0.0.1:${options.port}`);
      // An unprotected one is used as it is, and never stopped.
      await ownerServer(port, undefined, ["--fake-v2"]);
      const unprotected = await other.ensure();
      expect(unprotected).toMatchObject({ url: `http://127.0.0.1:${port}`, managed: false, api: 2, version: "2.2.5" });
      expect(await other.stop()).toBe(false);
    } finally {
      await Promise.all([bridge.close(), other.close()]);
      await dirs.cleanup();
    }
  }, 60_000);

  it("keeps why the owner's OpenCode is not used while CROT's copy serves; none of the owner's: not found", async () => {
    const dirs = await makeTempDirs();
    const options = await fakeOptions(dirs.outside);
    const bridge = new OpenCodeBridge({
      ...options,
      directory: path.join(dirs.outside, "opencode-chat"),
      command: async () => undefined,
      runtimeCommand: async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] }),
    });
    try {
      const server = await bridge.ensure();
      expect(server).toMatchObject({ managed: true, source: "crot", api: 2 });
      const ownerProblem = { code: "OPENCODE_NOT_INSTALLED", source: "owner", detail: "opencode: not found" };
      expect(server.ownerProblem).toEqual(ownerProblem);
      expect(await bridge.status()).toMatchObject({ server: { source: "crot", api: 2 }, ownerProblem });
      // Stopped: nothing serves, so nothing to explain.
      await bridge.stop();
      expect((await bridge.status()).ownerProblem).toBeUndefined();
    } finally {
      await bridge.close();
      await dirs.cleanup();
    }
  }, 60_000);

  it("compares OpenCode versions and keeps OpenCode's last error line, without the password", () => {
    expect(olderThan("0.15.31", OPENCODE_MIN_VERSION)).toBe(true);
    expect(olderThan("0.5.29", OPENCODE_MIN_VERSION)).toBe(true);
    expect(olderThan("1.0.0", OPENCODE_MIN_VERSION)).toBe(false);
    expect(olderThan("1.19.5", "1.2.0")).toBe(false);
    expect(olderThan("1.2.0", "1.19.5")).toBe(true);
    expect(olderThan("local", OPENCODE_MIN_VERSION)).toBe(false);
    expect(lastOutputLine("\u001b[31mError: boom\u001b[0m\nlistening on 127.0.0.1\n")).toBe("Error: boom");
    expect(lastOutputLine("starting\r\nready\r\n")).toBe("ready");
    expect(lastOutputLine("Error: password s3cr3t rejected\n", "s3cr3t")).toBe("Error: password [redacted] rejected");
    expect(lastOutputLine("\n \n")).toBeUndefined();
  });
});

/** OpenCode Zen: /models and streamed /chat/completions; `limited` keys get 429 for the free models. */
function zenServer() {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body?: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const url = req.url ?? "";
      seen.push({ url, headers: req.headers, ...(body ? { body } : {}) });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const priced = (id: string, name: string, price: number) => ({
        id,
        name,
        cost: { text: { input: { price }, output: { price } } },
        api: { "chat-completions": {} },
      });
      if (url === "/zen/v1/models")
        return json(200, {
          data: [priced("big-pickle", "Big Pickle", 0), priced("kimi-k2.6", "Kimi K2.6", 1)],
        });
      if (
        !req.headers.authorization ||
        (req.headers.authorization === "Bearer limited-key" && body?.model === "big-pickle")
      )
        return json(429, {
          type: "error",
          error: { type: "FreeUsageLimitError", message: "provider-text-do-not-show" },
        });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Zen answer from ${String(body?.model)}` } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return { seen, server };
}

describe("OpenCode through the local bridge", () => {
  async function setup(openCode?: (options: Awaited<ReturnType<typeof fakeOptions>>) => ProductHost["openCode"]) {
    const dirs = await makeTempDirs();
    const zen = zenServer();
    await new Promise<void>((r) => zen.server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(zen.server.address() as net.AddressInfo).port}/zen/v1`;
    const stateDir = path.join(dirs.outside, "state");
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const coreAudit = new MemoryAuditSink();
    const core: CrotCore = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
      },
      coreAudit,
    );
    const options = await fakeOptions(dirs.outside);
    const audit: string[] = [];
    const host: ProductHost = {
      stateDir,
      privateFiles,
      secrets: store,
      core: () => core,
      selectWorkspace: async () => {},
      recordControlEvent: async (event) => {
        if (event.action === "opencode_bridge") audit.push(`${String(event.value)}:${event.outcome}`);
        if (event.action === "opencode_runtime")
          audit.push(`runtime:${event.outcome}${event.reason ? `:${event.reason}` : ""}`);
      },
      openCode: openCode ? openCode(options) : options,
    };
    const runtime = await ProductRuntime.open(host);
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await runtime.request(method as never, params as never)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const listed = async (provider: string) =>
      ((await rpc("chat.providers")).providers as Record<string, unknown>[]).find((p) => p.provider === provider)!;
    const chat = async (provider: string, model: string, extra: Record<string, unknown> = {}) => {
      const started = await rpc("chat.start", { provider, model, message: "hello", projectTools: false, ...extra });
      await waitFor(async () => (await rpc("chat.poll", { id: started.id })).state !== "running", 15_000);
      return Object.assign(await rpc("chat.poll", { id: started.id }), { thread: started.thread as string });
    };
    const cleanup = async () => {
      await runtime.close();
      await core.shutdown();
      zen.server.closeAllConnections();
      await new Promise<void>((r) => zen.server.close(() => r()));
      await dirs.cleanup();
    };
    return { dirs, zen, endpoint, stateDir, options, audit, core, coreAudit, runtime, rpc, listed, chat, cleanup };
  }

  it("connects OpenCode Zen without a key through CROT's own OpenCode and stops it with CROT", async () => {
    const t = await setup();
    const { rpc, listed, chat, options } = t;
    try {
      expect(await rpc("opencode.status")).toEqual({
        ok: true,
        available: true,
        installCommand: "npm i -g opencode-ai",
        installed: true,
      });
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      // Listing models never starts OpenCode: the bundled free models.
      expect(await rpc("chat.models", { provider: ZEN })).toMatchObject({ ok: true, route: "local", idle: true });
      expect((await rpc("opencode.status")).server).toBeUndefined();

      const checked = await rpc("chat.testConnection", { provider: ZEN });
      expect(checked).toMatchObject({
        ok: true,
        route: "local",
        models: ["big-pickle", "glm-5.3-flash-free"],
        labels: { "big-pickle": "Big Pickle (free)", "glm-5.3-flash-free": "GLM-5.3-Flash (free)" },
        defaultModel: "big-pickle",
        server: { url: `http://127.0.0.1:${options.port}`, managed: true },
        // The chosen model answered OpenCode's test request.
        modelCheck: { model: "big-pickle", ok: true },
      });
      expect(await listed(ZEN)).toMatchObject({
        connectionStatus: "connected",
        route: "local",
        modelCheck: { model: "big-pickle", ok: true },
      });
      // The running server's PID file, so a later CROT can stop it if this one is killed.
      const pidFile = path.join(t.stateDir, "opencode-bridge.pid");
      expect(JSON.parse(await readFile(pidFile, "utf8"))).toMatchObject({
        port: options.port,
        command: process.execPath,
      });
      const status = await rpc("opencode.status");
      expect(status.server).toEqual({
        url: `http://127.0.0.1:${options.port}`,
        managed: true,
        version: "0.0.0-fake",
        source: "owner",
      });
      expect(JSON.stringify(status)).not.toMatch(/password/i);

      const answered = await chat(ZEN, "glm-5.3-flash-free");
      expect(answered.state).toBe("completed");
      expect(JSON.stringify(answered.blocks)).toContain("Local answer from glm-5.3-flash-free");
      // Model-only turns: every OpenCode tool off, CROT's empty directory, the session deleted afterwards.
      const log = await readLog(options.log);
      const messages = log.filter((l) => l.path.endsWith("/message"));
      expect(messages.map((m) => m.body?.model)).toEqual([
        { providerID: "opencode", modelID: "big-pickle" },
        { providerID: "opencode", modelID: "glm-5.3-flash-free" },
      ]);
      expect(messages[0]!.body?.parts).toEqual([{ type: "text", text: "Reply with OK." }]);
      for (const m of messages) {
        expect(m.body?.tools?.["*"]).toBe(false);
        expect(Object.values(m.body?.tools ?? {}).every((v) => v === false)).toBe(true);
        expect(m.body?.tools).toMatchObject({ bash: false, edit: false, write: false, read: false, webfetch: false });
      }
      const sessions = log.filter((l) => l.method === "POST" && l.path === "/session");
      expect(sessions).toHaveLength(2);
      for (const s of sessions) expect(s.directory).toBe(path.join(t.stateDir, "opencode-chat"));
      expect(log.filter((l) => l.method === "DELETE").map((l) => l.path)).toEqual(["/session/ses_1", "/session/ses_2"]);
      expect(t.zen.seen).toHaveLength(0);

      // Local OpenCode gets CROT's read-only project tools and enabled browser tools; other CROT tools and images need a Zen key.
      const tools = await chat(ZEN, "big-pickle", { tools: ["crot_status"] });
      expect(tools).toMatchObject({
        state: "failed",
        error: expect.stringContaining("read-only project tools and enabled browser tools"),
      });
      const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]).toString("base64");
      const image = await chat(ZEN, "big-pickle", { attachments: [{ name: "a.png", mime: "image/png", data: png }] });
      expect(image).toMatchObject({ state: "failed", error: expect.stringContaining("takes text only") });

      // OpenCode's free tier limit (OpenCode keeps retrying): stopped at once with a fixed message, followed by
      // OpenCode's own words (the model, the status, its reason and link).
      await writeFile(options.mode, "limit");
      const limited = await chat(ZEN, "big-pickle");
      expect(limited).toMatchObject({
        state: "failed",
        error: expect.stringContaining("free usage limit is reached"),
        errorDetail: "big-pickle · HTTP 429: Free usage exceeded, subscribe to Go (https://opencode.ai/go)",
      });
      expect(limited.error).not.toContain("subscribe");
      const after = await readLog(options.log);
      expect(after.filter((l) => l.path === "/session/ses_3/abort")).toHaveLength(1);
      expect(after.filter((l) => l.method === "DELETE" && l.path === "/session/ses_3")).toHaveLength(1);
      // Save & Test still connects (OpenCode is up and lists its models); the refused model is reported with it.
      const refused = await rpc("chat.testConnection", { provider: ZEN });
      const tierLimit = {
        code: "FREE_TIER_LIMIT",
        stage: "local",
        httpStatus: 429,
        model: "big-pickle",
        detail: "Free usage exceeded, subscribe to Go (https://opencode.ai/go)",
      };
      expect(refused).toMatchObject({
        ok: true,
        route: "local",
        models: ["big-pickle", "glm-5.3-flash-free"],
        modelCheck: { model: "big-pickle", ok: false, diagnostic: tierLimit },
      });
      expect(await listed(ZEN)).toMatchObject({
        connectionStatus: "connected",
        modelCheck: { model: "big-pickle", ok: false, diagnostic: tierLimit },
      });
      expect((await listed(ZEN)).connectionError).toBeUndefined();
      await writeFile(options.mode, "ok");

      // A saved model that OpenCode no longer lists: Save & Test picks its first free model instead; a chat
      // with the old one shows OpenCode's exact refusal (HTTP 500, UnknownError) after the fixed message.
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint, defaultModel: "retired-free" });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        defaultModel: "big-pickle",
        modelCheck: { model: "big-pickle", ok: true },
      });
      const retired = await chat(ZEN, "retired-free");
      expect(retired).toMatchObject({
        state: "failed",
        error: "Local OpenCode refused the request.",
        errorDetail:
          "retired-free · HTTP 500: UnknownError: Unexpected server error. Check server logs for details. (ref err_fake1)",
      });

      // Disconnecting stops CROT's server; connecting again starts a new one, and closing CROT stops it.
      await rpc("chat.remove", { provider: ZEN });
      expect((await rpc("opencode.status")).server).toBeUndefined();
      expect(await healthStatus(`http://127.0.0.1:${options.port}`)).toBe("down");
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({ ok: true, route: "local" });
      await t.runtime.close();
      expect(await healthStatus(`http://127.0.0.1:${options.port}`)).toBe("down");
      await expect(readFile(pidFile, "utf8")).rejects.toThrow();
      expect(t.audit).toEqual(["start:applied", "stop:applied", "start:applied", "stop:applied"]);
    } finally {
      await t.cleanup();
    }
  });

  it("keeps the conversation and reads the open project through Core over local OpenCode", async () => {
    const t = await setup();
    const { rpc, chat, options } = t;
    type Block = { type: string; text: string; name?: string; status?: string };
    const messages = async () => (await readLog(options.log)).filter((l) => l.path.endsWith("/message"));
    try {
      await mkdir(path.join(t.dirs.workspace, "notes"), { recursive: true });
      await writeFile(path.join(t.dirs.workspace, "notes", "plan.md"), "Plan: ship CROT-PLAN-42 on Friday.\n");
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({ ok: true, route: "local" });

      // Turn 1: the model asks for a project file in CROT's text protocol; Core reads it, the result goes back.
      const first = await chat(ZEN, "big-pickle", { message: "READ:notes/plan.md", projectTools: true });
      expect(first.state).toBe("completed");
      const blocks = first.blocks as Block[];
      expect(blocks.filter((b) => b.type === "tool")).toMatchObject([{ name: "fs_read_file", status: "completed" }]);
      expect(blocks.find((b) => b.type === "tool")!.text).toContain("notes/plan.md");
      const final = blocks.filter((b) => b.type === "assistant").at(-1)!;
      expect(final.text).toContain("Final answer from the tool results");
      expect(final.text).toContain("CROT-PLAN-42");
      // No tool block text reaches the owner as an answer.
      expect(blocks.some((b) => b.type === "assistant" && b.text.includes("```crot-tool\n"))).toBe(false);
      const turn = (await messages()).slice(-2);
      // One OpenCode session for the turn: the call, then the tool result as its next message.
      expect(turn[1]!.path).toBe(turn[0]!.path);
      expect(turn[0]!.body?.parts).toEqual([{ type: "text", text: "READ:notes/plan.md" }]);
      const result = turn[1]!.body?.parts?.[0]?.text as string;
      expect(result).toMatch(/^```crot-tool-result\n\{"tool":"fs_read_file","isError":false,"output":/);
      expect(result).toContain("CROT-PLAN-42");
      for (const m of turn) {
        // The open project's prompt and the tool protocol on every message; OpenCode's own tools stay off.
        expect(m.body?.system).toContain(`Project root: ${t.dirs.workspace}`);
        expect(m.body?.system).toContain("CROT tools: this conversation has no native tool calls");
        for (const name of ["fs_list_directory", "fs_read_file", "fs_stat", "project_search_files"])
          expect(m.body?.system).toContain(`- ${name}: `);
        expect(m.body?.system).not.toContain("- shell_run: ");
        expect(Object.values(m.body?.tools ?? {}).every((v) => v === false)).toBe(true);
      }

      // Turn 2 of the same thread: the earlier turn travels along; a tool not offered never runs.
      const second = await chat(ZEN, "big-pickle", {
        message: "CALL:shell_run",
        thread: first.thread,
        projectTools: true,
      });
      expect(second.state).toBe("completed");
      expect((second.blocks as Block[]).filter((b) => b.type === "tool")).toMatchObject([
        { name: "shell_run", status: "failed" },
      ]);
      expect(JSON.stringify(second.blocks)).toContain("Tool was not enabled by the user");
      const next = (await messages()).slice(-2);
      const sent = next[0]!.body?.parts?.[0]?.text as string;
      expect(sent).toMatch(/^Conversation so far:\nOwner: READ:notes\/plan\.md\n\nAssistant: Using fs_read_file\./);
      expect(sent).toContain("CROT-PLAN-42");
      expect(sent).toMatch(/\n\nNew message:\nCALL:shell_run$/);
      expect(next[0]!.path).not.toBe(turn[0]!.path);

      // The read ran through CrotCore: audited as the owner chat's operation on the project file.
      expect(
        t.coreAudit.events.filter((e) => "operation" in e && e.operation === "filesystem.read_file"),
      ).toMatchObject([
        {
          outcome: "success",
          paths: [path.join(t.dirs.workspace, "notes", "plan.md")],
          principal: { transport: "owner-chat" },
        },
      ]);

      // Every turn's OpenCode session is deleted afterwards.
      const log = await readLog(options.log);
      const created = log.filter((l) => l.method === "POST" && l.path === "/session").length;
      expect(log.filter((l) => l.method === "DELETE")).toHaveLength(created);
    } finally {
      await t.cleanup();
    }
  });

  it("uses the owner's OpenCode key (auth.json) with OpenCode's session headers, never showing it", async () => {
    const t = await setup();
    const { rpc, listed, chat, options } = t;
    try {
      const key = "sk-zen-local-key-1234567890";
      const file = path.join(options.local.env.XDG_DATA_HOME!, "opencode", "auth.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ opencode: { type: "api", key } }));
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      const checked = await rpc("chat.testConnection", { provider: ZEN });
      expect(checked).toMatchObject({
        ok: true,
        route: "zen",
        keySource: "auth.json",
        models: ["big-pickle", "kimi-k2.6"],
        // Zen serves free models only to OpenCode itself: the chosen free model is checked through local OpenCode.
        modelCheck: { model: "big-pickle", ok: true },
      });
      expect(checked.labels).toEqual({ "big-pickle": "Big Pickle (free)", "kimi-k2.6": "Kimi K2.6 (Zen / Go)" });
      expect(await listed(ZEN)).toMatchObject({
        connectionStatus: "connected",
        route: "zen",
        keySource: "auth.json",
        credentialStored: false,
      });
      expect((await rpc("opencode.status")).keySource).toBe("auth.json");

      const first = await chat(ZEN, "kimi-k2.6");
      expect(JSON.stringify(first.blocks)).toContain("Zen answer from kimi-k2.6");
      const second = await chat(ZEN, "kimi-k2.6", { thread: first.thread });
      expect(second.state).toBe("completed");
      // A free model: through local OpenCode, like OpenCode itself (the key is for the paid models).
      const free = await chat(ZEN, "big-pickle");
      expect(free.state).toBe("completed");
      expect(JSON.stringify(free.blocks)).toContain("Local answer from big-pickle");
      const other = await chat(ZEN, "kimi-k2.6");
      expect(other.state).toBe("completed");
      const requests = t.zen.seen.filter((s) => s.url === "/zen/v1/chat/completions");
      expect(requests).toHaveLength(3);
      expect(requests.map((r) => r.body?.model)).toEqual(["kimi-k2.6", "kimi-k2.6", "kimi-k2.6"]);
      for (const r of [...requests, t.zen.seen[0]!]) {
        expect(r.headers.authorization).toBe(`Bearer ${key}`);
        expect(r.headers["user-agent"]).toBe(`CROT/${CORE_VERSION}`);
        expect(r.headers["x-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.headers["x-opencode-session"]).toBe(r.headers["x-session-id"]);
      }
      // One session per thread.
      expect(requests[1]!.headers["x-session-id"]).toBe(requests[0]!.headers["x-session-id"]);
      expect(requests[2]!.headers["x-session-id"]).not.toBe(requests[0]!.headers["x-session-id"]);
      // Local OpenCode served the free model; it never gets the key, which is never shown.
      expect((await rpc("opencode.status")).server).toMatchObject({ managed: true, source: "owner" });
      expect(JSON.stringify(await readLog(options.log))).not.toContain(key);
      const shown = JSON.stringify([
        checked,
        await rpc("chat.providers"),
        await rpc("opencode.status"),
        first,
        second,
        free,
      ]);
      expect(shown).not.toContain(key);
      expect(await readFile(path.join(t.stateDir, "product-state.json"), "utf8").catch(() => "")).not.toContain(key);
      // Another host in the endpoint field never gets the owner's key.
      await rpc("chat.configure", { provider: ZEN, endpoint: "https://zen.example.test/zen/v1" });
      const elsewhere = await rpc("chat.models", { provider: ZEN });
      expect(elsewhere).toMatchObject({ ok: true, route: "local" });
      expect(elsewhere.keySource).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });

  it("answers through local OpenCode when Zen refuses a free model before any answer", async () => {
    const t = await setup();
    const { rpc, chat } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint, credential: "limited-key" });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        route: "zen",
        keySource: "stored",
      });
      const answered = await chat(ZEN, "big-pickle");
      expect(answered.state).toBe("completed");
      expect(JSON.stringify(answered.blocks)).toContain("Local answer from big-pickle");
      expect(JSON.stringify(answered)).not.toContain("provider-text-do-not-show");
      // A paid model is not moved: Zen's answer.
      const paid = await chat(ZEN, "kimi-k2.6");
      expect(JSON.stringify(paid.blocks)).toContain("Zen answer from kimi-k2.6");
    } finally {
      await t.cleanup();
    }
  });

  it("an earlier managed OpenCode workspace connection runs CROT's own server and stops it on request", async () => {
    const t = await setup();
    const { rpc, listed, chat, options } = t;
    try {
      await rpc("chat.configure", {
        provider: "OpenCode",
        endpoint: "http://127.0.0.1:4096",
        credential: "old",
        managed: true,
      });
      expect(await listed("OpenCode")).toMatchObject({ managed: true, credentialStored: false });
      expect(await rpc("chat.models", { provider: "OpenCode" })).toMatchObject({ ok: true, models: [], idle: true });
      expect((await rpc("opencode.status")).server).toBeUndefined();
      const checked = await rpc("chat.testConnection", { provider: "OpenCode" });
      expect(checked).toMatchObject({
        ok: true,
        models: ["opencode/big-pickle", "opencode/glm-5.3-flash-free"],
        server: { url: `http://127.0.0.1:${options.port}`, managed: true },
      });
      const answered = await chat("OpenCode", "opencode/big-pickle");
      expect(answered.state).toBe("completed");
      expect(JSON.stringify(answered.blocks)).toContain("Local answer from big-pickle");
      // A workspace turn keeps OpenCode's agent (its own tools and permissions).
      const message = (await readLog(options.log)).find((l) => l.path.endsWith("/message"));
      expect(message?.body?.tools).toBeUndefined();

      expect(await rpc("opencode.stop")).toMatchObject({ ok: true, stopped: true, installed: true });
      expect((await rpc("opencode.status")).server).toBeUndefined();
      expect(await rpc("chat.models", { provider: "OpenCode" })).toMatchObject({
        models: ["opencode/big-pickle"],
        idle: true,
      });
      // The next turn starts it again.
      const again = await chat("OpenCode", "opencode/glm-5.3-flash-free");
      expect(JSON.stringify(again.blocks)).toContain("Local answer from glm-5.3-flash-free");
      expect((await rpc("opencode.status")).server).toMatchObject({ managed: true });
      // Disconnecting the provider stops it.
      await rpc("chat.remove", { provider: "OpenCode" });
      expect((await rpc("opencode.status")).server).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });

  it("connects OpenCode Zen through OpenCode 2: its models, the check, chat and project reads through Core", async () => {
    const t = await setup((options) => ({
      ...options,
      command: async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] }),
    }));
    const { rpc, listed, chat, options } = t;
    type Block = { type: string; text: string; name?: string; status?: string };
    const generations = async () =>
      (await readLog(options.log)).filter((l) => l.path === "/api/experimental/generate/text");
    try {
      await mkdir(path.join(t.dirs.workspace, "notes"), { recursive: true });
      await writeFile(path.join(t.dirs.workspace, "notes", "plan.md"), "Plan: ship CROT-PLAN-42 on Friday.\n");
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      // Save & Test: OpenCode 2's enabled Zen chat models (/api/model), and one generation with the chosen one.
      const checked = await rpc("chat.testConnection", { provider: ZEN });
      expect(checked).toMatchObject({
        ok: true,
        route: "local",
        models: ["big-pickle", "glm-5.3-flash-free"],
        labels: { "big-pickle": "Big Pickle (free)", "glm-5.3-flash-free": "GLM-5.3-Flash (free)" },
        defaultModel: "big-pickle",
        server: { url: `http://127.0.0.1:${options.port}`, managed: true },
        modelCheck: { model: "big-pickle", ok: true },
      });
      expect(await listed(ZEN)).toMatchObject({ connectionStatus: "connected", route: "local" });
      expect((await rpc("opencode.status")).server).toEqual({
        url: `http://127.0.0.1:${options.port}`,
        managed: true,
        version: "2.2.5",
        api: 2,
        source: "owner",
      });
      expect((await generations()).map((g) => g.body)).toEqual([
        { prompt: "Reply with OK.", model: { providerID: "opencode", id: "big-pickle" } },
      ]);

      const answered = await chat(ZEN, "glm-5.3-flash-free");
      expect(answered.state).toBe("completed");
      expect(JSON.stringify(answered.blocks)).toContain("Local answer from glm-5.3-flash-free via OpenCode 2");

      // CROT's text tool protocol over stateless generations: the read runs through Core, its result goes back
      // with the conversation so far.
      const first = await chat(ZEN, "big-pickle", { message: "READ:notes/plan.md", projectTools: true });
      expect(first.state).toBe("completed");
      const blocks = first.blocks as Block[];
      expect(blocks.filter((b) => b.type === "tool")).toMatchObject([{ name: "fs_read_file", status: "completed" }]);
      const final = blocks.filter((b) => b.type === "assistant").at(-1)!;
      expect(final.text).toContain("Final answer from the tool results");
      expect(final.text).toContain("CROT-PLAN-42");
      const [call, result] = (await generations()).slice(-2).map((g) => String(g.body?.prompt));
      for (const prompt of [call!, result!]) {
        expect(prompt).toContain(`Project root: ${t.dirs.workspace}`);
        expect(prompt).toContain("CROT tools: this conversation has no native tool calls");
        expect(prompt).not.toContain("- shell_run: ");
      }
      expect(call).toMatch(/\n\nNew message:\nREAD:notes\/plan\.md$/);
      expect(result).toContain("Conversation so far:\nOwner: READ:notes/plan.md\n\nAssistant: Using fs_read_file.");
      expect(result).toMatch(
        /\n\nNew message:\n```crot-tool-result\n\{"tool":"fs_read_file","isError":false,"output":/,
      );
      expect(result).toContain("CROT-PLAN-42");
      // The next turn of the thread carries the earlier one; a tool not offered never runs.
      const second = await chat(ZEN, "big-pickle", {
        message: "CALL:shell_run",
        thread: first.thread,
        projectTools: true,
      });
      expect(second.state).toBe("completed");
      expect((second.blocks as Block[]).filter((b) => b.type === "tool")).toMatchObject([
        { name: "shell_run", status: "failed" },
      ]);
      const next = String((await generations()).at(-2)!.body?.prompt);
      expect(next).toContain("Conversation so far:\nOwner: READ:notes/plan.md\n\nAssistant: Using fs_read_file.");
      expect(next).toMatch(/\n\nNew message:\nCALL:shell_run$/);
      expect(
        t.coreAudit.events.filter((e) => "operation" in e && e.operation === "filesystem.read_file"),
      ).toMatchObject([{ outcome: "success", principal: { transport: "owner-chat" } }]);

      // A model OpenCode 2 does not list: its own refusal after the fixed message.
      const retired = await chat(ZEN, "retired-free");
      expect(retired).toMatchObject({
        state: "failed",
        error: "Local OpenCode refused the request.",
        errorDetail: "retired-free · HTTP 404: ModelNotFoundError: Model not found: opencode/retired-free",
      });
      // OpenCode 2's free usage limit (Zen's 429 inside its HTTP 502): the fixed message, then OpenCode's words.
      await writeFile(options.mode, "limit");
      const limited = await chat(ZEN, "big-pickle");
      expect(limited).toMatchObject({
        state: "failed",
        error:
          "OpenCode's free usage limit is reached (OpenCode suggests its Go subscription). Try again later, or choose a paid model with an OpenCode Zen API key.",
        errorDetail:
          "big-pickle · HTTP 429: ProviderRequestError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
      });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        modelCheck: {
          model: "big-pickle",
          ok: false,
          diagnostic: { code: "FREE_TIER_LIMIT", stage: "local", httpStatus: 429, model: "big-pickle" },
        },
      });
      // Only OpenCode 2's API: none of OpenCode 1.x's routes, and Zen is never asked.
      expect((await readLog(options.log)).every((l) => l.path.startsWith("/api/"))).toBe(true);
      expect(t.zen.seen).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("says why the owner's OpenCode is not used when CROT's OpenCode 2 copy hits the free tier", async () => {
    // No OpenCode of the owner: CROT's copy serves.
    const t = await setup(({ command: _command, ...options }) => ({
      ...options,
      runtimeCommand: async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] }),
    }));
    const { rpc, options } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      await writeFile(options.mode, "limit");
      const notFound = /^opencode: not found on PATH or in the usual install folders \(\d+ places checked\)$/;
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        route: "local",
        modelCheck: {
          ok: false,
          diagnostic: { code: "FREE_TIER_LIMIT", source: "crot", owner: expect.stringMatching(notFound) },
        },
      });
      expect(await rpc("opencode.status")).toMatchObject({
        server: { managed: true, source: "crot", api: 2 },
        ownerProblem: { code: "OPENCODE_NOT_INSTALLED", source: "owner", detail: expect.stringMatching(notFound) },
      });
      const limited = await t.chat(ZEN, "big-pickle");
      expect(limited.error).toContain("free limit is reached for CROT's own OpenCode copy (not signed in)");
      expect(String(limited.errorDetail).split(" — ")[1]).toMatch(notFound);
    } finally {
      await t.cleanup();
    }
  });

  it("with a key: free models through local OpenCode 2, paid ones from Zen", async () => {
    const t = await setup((options) => ({
      ...options,
      command: async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] }),
    }));
    const { rpc, chat } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint, credential: "zen-key" });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        route: "zen",
        keySource: "stored",
        models: ["big-pickle", "kimi-k2.6"],
        modelCheck: { model: "big-pickle", ok: true },
      });
      const free = await chat(ZEN, "big-pickle");
      expect(JSON.stringify(free.blocks)).toContain("Local answer from big-pickle via OpenCode 2");
      const paid = await chat(ZEN, "kimi-k2.6");
      expect(JSON.stringify(paid.blocks)).toContain("Zen answer from kimi-k2.6");
      expect(t.zen.seen.filter((s) => s.url === "/zen/v1/chat/completions").map((s) => s.body?.model)).toEqual([
        "kimi-k2.6",
      ]);
      expect(JSON.stringify(await readLog(t.options.log))).not.toContain("zen-key");
    } finally {
      await t.cleanup();
    }
  });

  it("with a key but without local OpenCode: the free model needs OpenCode, a paid one works", async () => {
    // Neither the owner's OpenCode nor CROT's copy; Zen refuses the free model for this key.
    const t = await setup(({ command: _command, ...options }) => options);
    const { rpc, listed, chat } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint, credential: "limited-key" });
      const missing = { code: "OPENCODE_NOT_INSTALLED", stage: "local", model: "big-pickle" };
      // Connected (the key lists Zen's models), with the warning that the chosen free model needs local OpenCode.
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        route: "zen",
        modelCheck: { model: "big-pickle", ok: false, diagnostic: missing },
      });
      expect(await listed(ZEN)).toMatchObject({
        connectionStatus: "connected",
        modelCheck: { model: "big-pickle", ok: false, diagnostic: missing },
      });
      // The chat asks Zen all the same; its refusal says what to do, never Zen's own text.
      const free = await chat(ZEN, "big-pickle");
      expect(free).toMatchObject({
        state: "failed",
        error:
          "Local OpenCode CLI was not found. Free models work only inside OpenCode: click “Install and start OpenCode (1 click)”, or choose a paid model with an OpenCode Zen API key.",
      });
      expect(JSON.stringify(free)).not.toContain("provider-text-do-not-show");
      const paid = await chat(ZEN, "kimi-k2.6");
      expect(JSON.stringify(paid.blocks)).toContain("Zen answer from kimi-k2.6");
      expect(t.zen.seen.filter((s) => s.url === "/zen/v1/chat/completions").map((s) => s.body?.model)).toEqual([
        "big-pickle",
        "kimi-k2.6",
      ]);
    } finally {
      await t.cleanup();
    }
  });

  it("the OpenCode workspace agent says that OpenCode 2 is not supported yet", async () => {
    const t = await setup((options) => ({
      ...options,
      command: async () => ({ command: process.execPath, args: [FAKE, "--fake-v2"] }),
    }));
    const { rpc, chat } = t;
    const unsupported =
      "This OpenCode server runs OpenCode 2, whose new server API the OpenCode workspace agent does not support yet. Use the Cloud LLM “OpenCode (Free & Zen)”: it works with OpenCode 2.";
    try {
      // An earlier "Start and connect": CROT's own server is OpenCode 2.
      await rpc("chat.configure", { provider: "OpenCode", endpoint: "http://127.0.0.1:4096", managed: true });
      expect(await rpc("chat.testConnection", { provider: "OpenCode" })).toMatchObject({
        ok: false,
        diagnostic: { code: "OPENCODE_V2_UNSUPPORTED" },
      });
      expect(await chat("OpenCode", "opencode/big-pickle")).toMatchObject({ state: "failed", error: unsupported });
      // The owner's own OpenCode 2 server: its web app's page is recognized, never taken for an answer.
      const port = await freePort();
      await ownerServer(port, undefined, ["--fake-v2"]);
      await rpc("chat.configure", { provider: "OpenCode", endpoint: `http://127.0.0.1:${port}`, managed: false });
      expect(await rpc("chat.testConnection", { provider: "OpenCode" })).toMatchObject({
        ok: false,
        diagnostic: { code: "OPENCODE_V2_UNSUPPORTED", stage: "workspace" },
      });
    } finally {
      await t.cleanup();
    }
  });

  /**
   * The registry of the one-click install: every build of this system, each a script that runs the fake OpenCode
   * (a real program on POSIX; on Windows only its `--version` check is played).
   */
  async function installHost(gate?: Promise<void>) {
    const names = [
      ...new Set([
        ...runtimePackages(process.platform, process.arch, false),
        ...runtimePackages(process.platform, process.arch, true),
      ]),
    ];
    const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
    const script = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} --fake-crot "$@"\n`;
    const registry = await fakeRegistry(
      Object.fromEntries(names.map((name) => [name, tgz({ [`package/bin/${exe}`]: script })])),
      gate,
    );
    const calls: { command: string; args: readonly string[] }[] = [];
    const install: OpenCodeInstallHost = {
      registry: registry.url,
      integrity: registry.integrity,
      // No Node.js or npm needed.
      npm: async () => false,
      run: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, output: `${OPENCODE_RUNTIME_VERSION}\n` };
      },
    };
    return { names, registry, calls, install };
  }

  it("Install and start OpenCode: CROT downloads the verified OpenCode in the background and connects through it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { names, registry, calls, install } = await installHost(gate);
    // The owner has no `opencode` of their own.
    const t = await setup(({ command: _command, ...options }) => ({ ...options, install }));
    const { rpc } = t;
    try {
      expect(await rpc("opencode.status")).toMatchObject({
        installed: false,
        installable: true,
        runtime: { state: "missing" },
      });
      // Without a key and without OpenCode: the bundled free models, and Save & Test says at once that OpenCode is
      // missing (with the one-click install) instead of asking Zen anonymously.
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      expect(await rpc("chat.models", { provider: ZEN })).toMatchObject({
        ok: true,
        models: [...OPENCODE_FREE_MODELS],
        route: "local",
        idle: true,
        installed: false,
      });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: false,
        diagnostic: { code: "OPENCODE_NOT_INSTALLED", stage: "local" },
        openCode: { installed: false, installable: true, runtime: { state: "missing" } },
      });
      expect(t.zen.seen).toHaveLength(0);
      expect(await rpc("opencode.install")).toMatchObject({
        ok: true,
        installed: false,
        runtime: { state: "installing" },
      });
      // A second click while it runs starts nothing new.
      expect((await rpc("opencode.install")).runtime).toEqual({ state: "installing" });
      release();
      await waitFor(async () => (await rpc("opencode.status")).runtime.state !== "installing", 10_000);
      expect(await rpc("opencode.status")).toMatchObject({
        installed: true,
        runtime: { state: "installed", version: OPENCODE_RUNTIME_VERSION },
      });
      // One download (the first build of this system), checked and kept in CROT's own folder.
      const directory = path.join(t.stateDir, "opencode-runtime");
      expect(registry.seen).toHaveLength(1);
      const name = /^\/([\w-]+)\//.exec(registry.seen[0]!)?.[1];
      expect(names).toContain(name);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(["--version"]);
      expect(path.relative(directory, calls[0]!.command).split(path.sep).slice(0, 2)).toEqual([
        "bin",
        expect.stringMatching(new RegExp(`^${name}-[0-9a-z]+$`)),
      ]);
      expect(t.audit).toEqual(["runtime:applied"]);
      if (process.platform === "win32") return;
      // Save & Test: through CROT's copy, in its own folders.
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        route: "local",
        server: { managed: true },
      });
      expect((await rpc("opencode.status")).server).toMatchObject({ managed: true, source: "crot" });
    } finally {
      await t.cleanup();
      await registry.close();
    }
  });

  it("says when OpenCode's free tier refuses the copy CROT installed, which is not signed in", async () => {
    // No OpenCode of the owner: CROT's copy serves.
    const t = await setup(({ command: _command, ...options }) => ({
      ...options,
      runtimeCommand: async () => ({ command: process.execPath, args: [FAKE] }),
    }));
    const { rpc, options } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      await writeFile(options.mode, "limit");
      const refused = await rpc("chat.testConnection", { provider: ZEN });
      const notFound = /^opencode: not found on PATH or in the usual install folders \(\d+ places checked\)$/;
      expect(refused).toMatchObject({
        ok: true,
        route: "local",
        modelCheck: {
          ok: false,
          diagnostic: {
            code: "FREE_TIER_LIMIT",
            stage: "local",
            source: "crot",
            owner: expect.stringMatching(notFound),
          },
        },
      });
      const status = await rpc("opencode.status");
      expect(status.server).toMatchObject({ managed: true, source: "crot" });
      expect(status.ownerProblem).toEqual({
        code: "OPENCODE_NOT_INSTALLED",
        source: "owner",
        detail: expect.stringMatching(notFound),
      });
      const limited = await t.chat(ZEN, "big-pickle");
      expect(limited).toMatchObject({
        state: "failed",
        error: expect.stringContaining("free limit is reached for CROT's own OpenCode copy (not signed in)"),
      });
      expect(limited.error).toContain("An API key does not unlock free models");
      const [said, why] = String(limited.errorDetail).split(" — ");
      expect(said).toBe("big-pickle · HTTP 429: Free usage exceeded, subscribe to Go (https://opencode.ai/go)");
      expect(why).toMatch(notFound);
      expect(t.zen.seen).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("offers the verified OpenCode when the owner's does not start, and connects through it", async () => {
    const { registry, install } = await installHost();
    // The owner's OpenCode: an npm installation whose postinstall script did not run.
    const t = await setup((options) => ({
      ...options,
      command: async () => ({ command: process.execPath, args: [FAKE, "--fake-crash"] }),
      install,
    }));
    const { rpc } = t;
    try {
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      const why = `${process.execPath}: exited with code 1 — Error: opencode-ai's postinstall script was not run.`;
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: false,
        diagnostic: { code: "OPENCODE_START_FAILED", stage: "local", detail: why },
      });
      expect(await rpc("opencode.status")).toMatchObject({
        installed: true,
        installable: true,
        runtime: { state: "missing" },
        problem: { code: "OPENCODE_START_FAILED", source: "owner", detail: why },
      });
      // A chat turn says the same, with OpenCode's reason after the fixed message.
      const turn = await t.chat(ZEN, "big-pickle");
      expect(turn).toMatchObject({
        state: "failed",
        error: expect.stringContaining("install the verified OpenCode into CROT with one click"),
        errorDetail: why,
      });
      expect(t.zen.seen).toHaveLength(0);
      await rpc("opencode.install");
      await waitFor(async () => (await rpc("opencode.status")).runtime.state === "installed", 10_000);
      if (process.platform === "win32") return;
      const connected = await rpc("chat.testConnection", { provider: ZEN });
      expect(connected).toMatchObject({ ok: true, route: "local", server: { managed: true } });
      const status = await rpc("opencode.status");
      expect(status.server).toMatchObject({ managed: true, source: "crot" });
      expect(status.problem).toBeUndefined();
      // The card says why the owner's own OpenCode is not used.
      expect(status.ownerProblem).toEqual({ code: "OPENCODE_START_FAILED", source: "owner", detail: why });
    } finally {
      await t.cleanup();
      await registry.close();
    }
  });

  it("refuses to install OpenCode while starting processes is stopped; without npm the download says why", async () => {
    const port = await freePort();
    const t = await setup(({ command: _command, ...options }) => ({
      ...options,
      install: {
        registry: `http://127.0.0.1:${port}`,
        npm: async () => false,
        run: async () => ({ code: 0, output: "" }),
      },
    }));
    try {
      expect(await t.rpc("opencode.status")).toMatchObject({ installable: true, runtime: { state: "missing" } });
      await t.rpc("opencode.install");
      await waitFor(async () => (await t.rpc("opencode.status")).runtime.state === "failed");
      expect((await t.rpc("opencode.status")).runtime).toEqual({
        state: "failed",
        reason: "download_failed",
        detail: "ECONNREFUSED",
      });
      // The emergency stop: no installation starts.
      await t.runtime.abortAll();
      t.core.permissions.runtime.stop();
      await t.rpc("opencode.install");
      await waitFor(async () => (await t.rpc("opencode.status")).runtime.reason === "opencode_refused");
      expect(t.audit).toEqual(["runtime:failed:download_failed", "runtime:failed:opencode_refused"]);
    } finally {
      await t.cleanup();
    }
  });
});
