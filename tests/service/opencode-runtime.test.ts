/**
 * "Install and start OpenCode": CROT downloads the pinned OpenCode's platform package straight from the npm
 * registry (a local fake one here), checks its sha512, unpacks only its binary into <stateDir>/opencode-runtime
 * and keeps the build that runs here; npm is only the fallback when the download fails. A fake host stands in
 * for the binary check and npm; runProgram runs real (Node) processes.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import {
  extractTarEntry,
  OPENCODE_RUNTIME_INTEGRITY,
  OPENCODE_RUNTIME_VERSION,
  OpenCodeRuntime,
  runProgram,
  runtimePackages,
  type OpenCodeInstallHost,
} from "../../src/service/opencode-runtime.js";
import { fakeRegistry, tgz } from "../fixtures/opencode-registry.js";
import { makeTempDirs } from "../helpers.js";

const ENV = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);
const LINUX = { platform: "linux" as const, arch: "x64", musl: false, avx2: true };

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
}
/** A platform package as the registry has it: package.json and bin/opencode. */
const platformPackage = (name: string, bin = "opencode") =>
  tgz({
    "package/package.json": JSON.stringify({ name, version: OPENCODE_RUNTIME_VERSION }),
    [`package/bin/${bin}`]: `#!/bin/sh\necho ${name}\n`,
  });
/** The binary check (`--version`, as `version` says) and a fake npm that "installs" `packages`. */
function fakeHost(
  registry: { url: string; integrity?: Record<string, string> },
  options: {
    npm?: boolean;
    code?: number;
    packages?: readonly string[];
    version?: (binary: string) => { code: number; output: string };
  } = {},
) {
  const calls: Call[] = [];
  const host: OpenCodeInstallHost = {
    registry: registry.url,
    ...(registry.integrity ? { integrity: registry.integrity } : {}),
    npm: async () => options.npm ?? false,
    run: async (command, args, { cwd }) => {
      calls.push({ command, args, cwd });
      if (command !== "npm") return options.version?.(command) ?? { code: 0, output: `${OPENCODE_RUNTIME_VERSION}\n` };
      for (const name of options.packages ?? []) {
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
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

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
    // A CPU without AVX2: the baseline builds first.
    expect(runtimePackages("linux", "x64", false, false)).toEqual([
      "opencode-linux-x64-baseline",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64-musl",
    ]);
    expect(runtimePackages("linux", "x64", true, false)[0]).toBe("opencode-linux-x64-baseline-musl");
    expect(runtimePackages("win32", "x64", false, false)).toEqual([
      "opencode-windows-x64-baseline",
      "opencode-windows-x64",
    ]);
    expect(runtimePackages("darwin", "arm64", false, false)).toEqual(["opencode-darwin-arm64"]);
    // Every package CROT may download has its published sha512 pinned.
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ] as const)
      for (const name of [...runtimePackages(platform, arch, false), ...runtimePackages(platform, arch, true)])
        expect(OPENCODE_RUNTIME_INTEGRITY[name], name).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it("downloads the pinned version, checks its sha512, unpacks only its binary and keeps the build that runs", async () => {
    const dirs = await makeTempDirs();
    const directory = path.join(dirs.outside, "opencode-runtime");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const registry = await fakeRegistry(
      {
        "opencode-linux-x64": platformPackage("opencode-linux-x64"),
        "opencode-linux-x64-baseline": platformPackage("opencode-linux-x64-baseline"),
      },
      gate,
    );
    const { host, calls } = fakeHost(registry, {
      // The AVX2 build does not run on this CPU: the baseline one is kept.
      version: (binary) =>
        path.basename(path.dirname(binary)).startsWith("opencode-linux-x64-baseline-")
          ? { code: 0, output: "1.19.5\n" }
          : { code: 132, output: "" },
    });
    const records: string[] = [];
    const runtime = new OpenCodeRuntime({
      directory,
      ...LINUX,
      host,
      record: (outcome, reason) => records.push(reason ? `${outcome}:${reason}` : outcome),
    });
    try {
      // What an earlier npm installation left: removed once the new binary runs.
      await mkdir(path.join(directory, "node_modules", "opencode-linux-x64", "bin"), { recursive: true });
      await writeFile(path.join(directory, "package.json"), "{}");
      await writeFile(path.join(directory, "package-lock.json"), "{}");
      await mkdir(path.join(directory, "bin", "opencode-linux-x64-old"), { recursive: true });
      expect(await runtime.status()).toEqual({ state: "missing" });
      expect(await runtime.binary()).toBeUndefined();
      expect(await runtime.start()).toEqual({ state: "installing" });
      const [a, b] = [runtime.install(), runtime.install()];
      expect(await runtime.status()).toEqual({ state: "installing" });
      release();
      expect(await a).toEqual({ state: "installed", version: "1.19.5" });
      expect(await b).toEqual({ state: "installed", version: "1.19.5" });
      // One download per build tried, from the registry's package path; no npm.
      expect(registry.seen).toEqual([
        `/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_RUNTIME_VERSION}.tgz`,
        `/opencode-linux-x64-baseline/-/opencode-linux-x64-baseline-${OPENCODE_RUNTIME_VERSION}.tgz`,
      ]);
      expect(calls.filter((c) => c.command === "npm")).toEqual([]);
      const binary = (await runtime.binary())!;
      expect(path.dirname(path.dirname(binary))).toBe(path.join(directory, "bin"));
      expect(path.basename(path.dirname(binary))).toMatch(/^opencode-linux-x64-baseline-[0-9a-z]+$/);
      expect(calls.map((c) => [path.basename(path.dirname(c.command)).replace(/-[0-9a-z]+$/, ""), c.args])).toEqual([
        ["opencode-linux-x64", ["--version"]],
        ["opencode-linux-x64-baseline", ["--version"]],
      ]);
      expect(calls[1]!.command).toBe(binary);
      // Only bin/opencode of the package, executable.
      expect(await readFile(binary, "utf8")).toBe("#!/bin/sh\necho opencode-linux-x64-baseline\n");
      if (process.platform !== "win32") expect((await stat(binary)).mode & 0o777).toBe(0o755);
      expect(await readdir(path.dirname(binary))).toEqual(["opencode"]);
      expect(await runtime.status()).toEqual({ state: "installed", version: "1.19.5" });
      // The build that did not run, earlier installations and npm's leftovers are gone; no download is left.
      expect(await readdir(path.join(directory, "bin"))).toEqual([path.basename(path.dirname(binary))]);
      expect((await readdir(directory)).sort()).toEqual(["bin", "crot-runtime.json"]);
      expect(JSON.parse(await readFile(path.join(directory, "crot-runtime.json"), "utf8"))).toEqual({
        version: "1.19.5",
        package: "opencode-linux-x64-baseline",
        binary: path.relative(directory, binary),
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
      await registry.close();
      await dirs.cleanup();
    }
  });

  it("falls back to npm without package scripts only when the download fails", async () => {
    const dirs = await makeTempDirs();
    const directory = path.join(dirs.outside, "opencode-runtime");
    const unreachable = { url: `http://127.0.0.1:${await closedPort()}` };
    const { host, calls } = fakeHost(unreachable, {
      npm: true,
      packages: ["opencode-linux-x64", "opencode-linux-x64-baseline"],
    });
    const runtime = new OpenCodeRuntime({ directory, ...LINUX, host });
    try {
      expect(await runtime.install()).toEqual({ state: "installed", version: OPENCODE_RUNTIME_VERSION });
      expect(calls.filter((c) => c.command === "npm")).toEqual([
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
      const binary = path.join(directory, "node_modules", "opencode-linux-x64", "bin", "opencode");
      expect(await runtime.binary()).toBe(binary);
      // The other build (about 200 MB) is removed; the wrapper package stays.
      expect((await readdir(path.join(directory, "node_modules"))).sort()).toEqual([
        "opencode-ai",
        "opencode-linux-x64",
      ]);
      expect(JSON.parse(await readFile(path.join(directory, "crot-runtime.json"), "utf8"))).toMatchObject({
        package: "opencode-linux-x64",
        binary: path.join("node_modules", "opencode-linux-x64", "bin", "opencode"),
      });
    } finally {
      await runtime.close();
      await dirs.cleanup();
    }
  });

  it("fails with a reason: refused, no download, checksum differs, npm failing, no build that runs, cancelled", async () => {
    const dirs = await makeTempDirs();
    const linux = "opencode-linux-x64";
    const options = (name: string) => ({ directory: path.join(dirs.outside, name), ...LINUX });
    const good = await fakeRegistry({ [linux]: platformPackage(linux) });
    const empty = await fakeRegistry({});
    const port = await closedPort();
    const unreachable = { url: `http://127.0.0.1:${port}` };
    try {
      const refusedHost = fakeHost(good);
      const refused = new OpenCodeRuntime({ ...options("refused"), host: refusedHost.host, allowed: () => false });
      expect(await refused.install()).toEqual({ state: "failed", reason: "opencode_refused" });
      expect(refusedHost.calls).toEqual([]);
      expect(good.seen).toEqual([]);
      expect(await refused.status()).toEqual({ state: "failed", reason: "opencode_refused" });

      // No connection and no npm, or the registry refusing: the download's error in a few words.
      const offline = new OpenCodeRuntime({ ...options("offline"), host: fakeHost(unreachable).host });
      expect(await offline.install()).toEqual({ state: "failed", reason: "download_failed", detail: "ECONNREFUSED" });
      expect(await offline.status()).toEqual({ state: "failed", reason: "download_failed", detail: "ECONNREFUSED" });
      const missing = new OpenCodeRuntime({
        ...options("missing"),
        host: fakeHost({ url: empty.url, integrity: good.integrity }).host,
      });
      expect(await missing.install()).toEqual({ state: "failed", reason: "download_failed", detail: "HTTP 404" });

      // A package that differs from the published one is never unpacked.
      const tampered = new OpenCodeRuntime({
        ...options("tampered"),
        host: fakeHost({ url: good.url, integrity: { [linux]: OPENCODE_RUNTIME_INTEGRITY[linux]! } }).host,
      });
      expect(await tampered.install()).toEqual({
        state: "failed",
        reason: "integrity_mismatch",
        detail: `${linux}: sha512 differs from the published one`,
      });
      expect(await readdir(path.join(dirs.outside, "tampered"))).toEqual([]);

      // npm (the fallback) failing.
      const broken = new OpenCodeRuntime({
        ...options("broken"),
        host: fakeHost(unreachable, { npm: true, code: 1 }).host,
      });
      expect(await broken.install()).toEqual({
        state: "failed",
        reason: "install_failed",
        detail: "ECONNREFUSED; npm exited with code 1",
      });

      // A package without the binary, or no build that runs here.
      const hollow = await fakeRegistry({ [linux]: tgz({ "package/package.json": "{}" }) });
      const noBinary = new OpenCodeRuntime({ ...options("hollow"), host: fakeHost(hollow).host });
      expect(await noBinary.install()).toEqual({
        state: "failed",
        reason: "binary_not_found",
        detail: `${linux}: no bin/opencode in the package`,
      });
      await hollow.close();
      const crashing = new OpenCodeRuntime({
        ...options("crash"),
        host: fakeHost(good, { version: () => ({ code: 1, output: "" }) }).host,
      });
      expect(await crashing.install()).toEqual({
        state: "failed",
        reason: "binary_not_found",
        detail: `${linux}: --version exited with code 1`,
      });
      expect(await crashing.binary()).toBeUndefined();
      expect(await readdir(path.join(dirs.outside, "crash", "bin"))).toEqual([]);

      // The emergency stop cancels a running installation; a later start installs again.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = await fakeRegistry({ [linux]: platformPackage(linux) }, gate);
      const cancelled = new OpenCodeRuntime({ ...options("cancel"), host: fakeHost(slow).host });
      const running = cancelled.install();
      await new Promise((r) => setTimeout(r, 50));
      cancelled.cancel();
      expect(await running).toEqual({ state: "failed", reason: "cancelled" });
      release();
      expect(await cancelled.install()).toEqual({ state: "installed", version: OPENCODE_RUNTIME_VERSION });
      await cancelled.close();
      expect(await cancelled.install()).toEqual({ state: "failed", reason: "cancelled" });
      await slow.close();
    } finally {
      await Promise.all([good.close(), empty.close()]);
      await dirs.cleanup();
    }
  });

  it("unpacks exactly one entry of an npm package, also behind a long-name header", async () => {
    const dirs = await makeTempDirs();
    const archive = path.join(dirs.outside, "package.tgz");
    const long = `package/${"x".repeat(120)}/opencode`;
    await writeFile(
      archive,
      tgz({ "package/README.md": "readme", "package/bin/opencode": "binary", [long]: "long", "package/bin/x": "x" }),
    );
    try {
      expect(await extractTarEntry(archive, "package/bin/opencode", path.join(dirs.outside, "a"))).toBe(true);
      expect(await readFile(path.join(dirs.outside, "a"), "utf8")).toBe("binary");
      expect(await extractTarEntry(archive, long, path.join(dirs.outside, "b"))).toBe(true);
      expect(await readFile(path.join(dirs.outside, "b"), "utf8")).toBe("long");
      expect(await extractTarEntry(archive, "package/bin/opencode.exe", path.join(dirs.outside, "c"))).toBe(false);
      expect((await readdir(dirs.outside)).sort()).toEqual(["a", "b", "package.tgz"]);
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
