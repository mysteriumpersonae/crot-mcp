/**
 * "Install and start OpenCode": npm installs the pinned opencode-ai into <stateDir>/opencode-runtime without
 * package scripts, CROT picks the platform binary that runs here and removes the other variants. A fake npm
 * stands in for the real one; runProgram runs real (Node) processes.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import {
  OPENCODE_RUNTIME_VERSION,
  OpenCodeRuntime,
  runProgram,
  runtimePackages,
  type OpenCodeInstallHost,
} from "../../src/service/opencode-runtime.js";
import { makeTempDirs } from "../helpers.js";

const ENV = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
}
/** A fake npm that "installs" the given platform packages; binaries answer --version as `version` says. */
function fakeHost(
  packages: readonly string[],
  options: {
    npm?: boolean;
    code?: number;
    gate?: Promise<void>;
    version?: (binary: string) => { code: number; output: string };
  } = {},
) {
  const calls: Call[] = [];
  const host: OpenCodeInstallHost = {
    npm: async () => options.npm ?? true,
    run: async (command, args, { cwd, signal }) => {
      calls.push({ command, args, cwd });
      if (command !== "npm") return options.version?.(command) ?? { code: 0, output: `${OPENCODE_RUNTIME_VERSION}\n` };
      if (options.gate)
        await Promise.race([
          options.gate,
          new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      if (signal?.aborted) return { code: null, output: "" };
      for (const name of packages) {
        const bin = path.join(cwd, "node_modules", name, "bin");
        await mkdir(bin, { recursive: true });
        await writeFile(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
      }
      await mkdir(path.join(cwd, "node_modules", "opencode-ai", "bin"), { recursive: true });
      return { code: options.code ?? 0, output: "added 3 packages" };
    },
  };
  return { host, calls };
}

describe("OpenCode runtime (one-click install)", () => {
  it("lists opencode-ai's platform packages in the order of its own postinstall", () => {
    expect(runtimePackages("linux", "x64", false)).toEqual([
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
      "opencode-linux-x64-musl",
      "opencode-linux-x64-baseline-musl",
    ]);
    expect(runtimePackages("linux", "x64", true)[0]).toBe("opencode-linux-x64-musl");
    expect(runtimePackages("linux", "arm64", false)).toEqual(["opencode-linux-arm64", "opencode-linux-arm64-musl"]);
    expect(runtimePackages("darwin", "arm64", false)).toEqual(["opencode-darwin-arm64"]);
    expect(runtimePackages("darwin", "x64", false)).toEqual(["opencode-darwin-x64", "opencode-darwin-x64-baseline"]);
    expect(runtimePackages("win32", "x64", false)).toEqual(["opencode-windows-x64", "opencode-windows-x64-baseline"]);
  });

  it("installs the pinned version without package scripts, once, and keeps the binary that runs", async () => {
    const dirs = await makeTempDirs();
    const directory = path.join(dirs.outside, "opencode-runtime");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { host, calls } = fakeHost(["opencode-linux-x64", "opencode-linux-x64-baseline"], {
      gate,
      // The AVX2 build does not run on this CPU: the baseline one is kept.
      version: (binary) =>
        binary.includes(`opencode-linux-x64${path.sep}`) ? { code: 132, output: "" } : { code: 0, output: "1.19.5\n" },
    });
    const records: string[] = [];
    const runtime = new OpenCodeRuntime({
      directory,
      platform: "linux",
      arch: "x64",
      musl: false,
      host,
      record: (outcome, reason) => records.push(reason ? `${outcome}:${reason}` : outcome),
    });
    try {
      expect(await runtime.status()).toEqual({ state: "missing" });
      expect(await runtime.binary()).toBeUndefined();
      expect(await runtime.start()).toEqual({ state: "installing" });
      const [a, b] = [runtime.install(), runtime.install()];
      expect(await runtime.status()).toEqual({ state: "installing" });
      release();
      expect(await a).toEqual({ state: "installed", version: "1.19.5" });
      expect(await b).toEqual({ state: "installed", version: "1.19.5" });
      // One npm run: the pinned package into the runtime directory, no scripts, nothing else from the owner.
      const npm = calls.filter((c) => c.command === "npm");
      expect(npm).toEqual([
        {
          command: "npm",
          args: [
            "install",
            "--prefix",
            directory,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-update-notifier",
            "--loglevel=error",
            "--save-exact",
            `opencode-ai@${OPENCODE_RUNTIME_VERSION}`,
          ],
          cwd: directory,
        },
      ]);
      expect(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))).toMatchObject({
        private: true,
      });
      const baseline = path.join(directory, "node_modules", "opencode-linux-x64-baseline", "bin", "opencode");
      expect(calls.filter((c) => c.command !== "npm").map((c) => [c.command, c.args])).toEqual([
        [path.join(directory, "node_modules", "opencode-linux-x64", "bin", "opencode"), ["--version"]],
        [baseline, ["--version"]],
      ]);
      expect(await runtime.binary()).toBe(baseline);
      expect(await runtime.status()).toEqual({ state: "installed", version: "1.19.5" });
      // The other variant (about 200 MB) is removed; the wrapper package stays.
      expect((await readdir(path.join(directory, "node_modules"))).sort()).toEqual([
        "opencode-ai",
        "opencode-linux-x64-baseline",
      ]);
      expect(JSON.parse(await readFile(path.join(directory, "crot-runtime.json"), "utf8"))).toEqual({
        version: "1.19.5",
        package: "opencode-linux-x64-baseline",
        binary: path.join("node_modules", "opencode-linux-x64-baseline", "bin", "opencode"),
      });
      expect(records).toEqual(["applied"]);
      // A manifest pointing outside the runtime directory is never used.
      await writeFile(
        path.join(directory, "crot-runtime.json"),
        JSON.stringify({ version: "1", package: "x", binary: path.join("..", "..", "elsewhere", "opencode") }),
      );
      expect(await runtime.binary()).toBeUndefined();
    } finally {
      await runtime.close();
      await dirs.cleanup();
    }
  });

  it("fails with a reason: refused, no npm, npm failing, no binary that runs, cancelled", async () => {
    const dirs = await makeTempDirs();
    const options = (name: string) => ({
      directory: path.join(dirs.outside, name),
      platform: "linux" as const,
      arch: "x64",
      musl: false,
    });
    const linux = ["opencode-linux-x64"];
    try {
      const refusedHost = fakeHost(linux);
      const refused = new OpenCodeRuntime({ ...options("refused"), host: refusedHost.host, allowed: () => false });
      expect(await refused.install()).toEqual({ state: "failed", reason: "opencode_refused" });
      expect(refusedHost.calls).toEqual([]);
      expect(await refused.status()).toEqual({ state: "failed", reason: "opencode_refused" });

      const noNpm = new OpenCodeRuntime({ ...options("no-npm"), host: fakeHost(linux, { npm: false }).host });
      expect(await noNpm.install()).toEqual({ state: "failed", reason: "npm_not_found" });

      const broken = new OpenCodeRuntime({ ...options("broken"), host: fakeHost(linux, { code: 1 }).host });
      expect(await broken.install()).toEqual({ state: "failed", reason: "install_failed" });

      const wrong = new OpenCodeRuntime({ ...options("wrong"), host: fakeHost(["opencode-darwin-arm64"]).host });
      expect(await wrong.install()).toEqual({ state: "failed", reason: "binary_not_found" });
      const crash = fakeHost(linux, { version: () => ({ code: 1, output: "" }) });
      const crashing = new OpenCodeRuntime({ ...options("crash"), host: crash.host });
      expect(await crashing.install()).toEqual({ state: "failed", reason: "binary_not_found" });
      expect(await crashing.binary()).toBeUndefined();

      // The emergency stop cancels a running installation; a later start installs again.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = fakeHost(linux, { gate });
      const cancelled = new OpenCodeRuntime({ ...options("cancel"), host: slow.host });
      const running = cancelled.install();
      await new Promise((r) => setTimeout(r, 20));
      cancelled.cancel();
      expect(await running).toEqual({ state: "failed", reason: "cancelled" });
      release();
      expect(await cancelled.install()).toEqual({ state: "installed", version: OPENCODE_RUNTIME_VERSION });
      await cancelled.close();
      expect(await cancelled.install()).toEqual({ state: "failed", reason: "cancelled" });
    } finally {
      await dirs.cleanup();
    }
  });

  it("runs a program to its end, and stops it at the deadline or on cancel", async () => {
    const dirs = await makeTempDirs();
    const { launcher } = await createNodePlatform({ startupPath: "inherited" });
    const run = (args: string[], timeoutMs: number, signal?: AbortSignal) =>
      runProgram(launcher, process.execPath, args, { cwd: dirs.outside, env: ENV, timeoutMs, signal });
    try {
      expect(await run(["-e", "console.log('1.19.5'); console.error('warn')"], 30_000)).toMatchObject({
        code: 0,
        output: expect.stringContaining("1.19.5"),
      });
      expect((await run(["-e", "process.exit(4)"], 30_000)).code).toBe(4);
      const started = Date.now();
      expect((await run(["-e", "setInterval(() => {}, 1000)"], 300)).code).not.toBe(0);
      const controller = new AbortController();
      const cancelled = run(["-e", "setInterval(() => {}, 1000)"], 30_000, controller.signal);
      setTimeout(() => controller.abort(), 200);
      expect((await cancelled).code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(20_000);
      // A name is looked up on PATH, never in the working directory.
      await expect(
        runProgram(launcher, "crot-no-such-program", [], { cwd: dirs.outside, env: ENV, timeoutMs: 1000 }),
      ).rejects.toThrow();
    } finally {
      await dirs.cleanup();
    }
  });
});
