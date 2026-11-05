/**
 * OpenCode installed by CROT ("Install and start OpenCode (1 click)"), for owners without a working `opencode`
 * of their own: the pinned OpenCode for this system, downloaded straight from the npm registry into
 * <stateDir>/opencode-runtime — no terminal, Node.js or npm needed. Each platform package must match the
 * sha512 the registry published for it (OPENCODE_RUNTIME_INTEGRITY, pinned here); its binary is unpacked to
 * bin/ and must answer `--version` (opencode-<os>-<arch>[-musl][-baseline] in the order of opencode-ai's own
 * postinstall, the next variant when one does not run here). Only when the download fails (the registry cannot
 * be reached or answers with an error) and npm is installed does npm install the pinned opencode-ai instead (npm
 * knows the owner's registry and proxy settings), without running package scripts.
 *
 * The binary check and npm are control-plane helpers like the bridge: started by the owner, with the
 * allowlisted child environment, refused by the emergency stop or an explicit runtime deny of process.start.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants, createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { ProcessLauncher } from "../core/platform/types.js";

export const OPENCODE_RUNTIME_PACKAGE = "opencode-ai";
/** The OpenCode version CROT installs (the one CROT's bridge is tested with). */
export const OPENCODE_RUNTIME_VERSION = "1.19.5";
/** Where the platform packages come from: https://registry.npmjs.org/<name>/-/<name>-<version>.tgz */
export const OPENCODE_REGISTRY = "https://registry.npmjs.org";
/** The registry's sha512 (dist.integrity) of each platform package of OPENCODE_RUNTIME_VERSION. */
export const OPENCODE_RUNTIME_INTEGRITY: Readonly<Record<string, string>> = Object.freeze({
  "opencode-linux-x64":
    "sha512-i1qh7VooLGML9xX6ud93y0JA8j/1aPeDYRKjsmYXrJX1TjIWHgBBMkEbEJPZthpWbsJg//XfBgR6Kb7+NPaJiQ==",
  "opencode-linux-x64-baseline":
    "sha512-9kA+st3XXtCXMPx5f3Ld1u19uoHTO2u2Btt8a2cqhJ4GIqVbD1mXLevj3LHFEmtuQoFGk+UstGnl38sCqXj5sQ==",
  "opencode-linux-x64-musl":
    "sha512-y6nUbH3ViajN37KaVVy0/KnWv/i48Bx5QPv9Ul9ONJya1ossV7CHVb+ZNFc61M5GqlVtjCvZV7T0eBMqhJG7mg==",
  "opencode-linux-x64-baseline-musl":
    "sha512-kwt6hmTaI6nujjAzdAkXv3j2rDzXNOMfMk8Jf8bwacHtwUl8CWA2psDVg3nWyb4zByAa6F1jSIlmHCPHBq1K/Q==",
  "opencode-linux-arm64":
    "sha512-u2HFRI6v1nNMVKiV34An8XrGBxJeZ+RCg2tYu3SqlGODKqKsr5RoEbaX1tnsfGb+rETh9AJVX9kS8dSZXPufsA==",
  "opencode-linux-arm64-musl":
    "sha512-YxvpVPJ/jeevV93DVRiuOVbhkoJAuwQUadPDHPaw65aZkAKZ6OE7XySwCS+Rjlhzt7fPryisvAOjUtZkwfMBuQ==",
  "opencode-darwin-arm64":
    "sha512-0MbSbKkmwVHtgP31GJyyECe6QVy4T7W4Wp7s2TsmXHTPPyf01ne3dWSX97X9dkNK28Lc6kt+zMPQUP/9GgDLZg==",
  "opencode-darwin-x64":
    "sha512-+DO7IMPTCrX12UJXnL4pL3ckcwR6BR6f6tA9QIlVQ5nZx66T5U7FRMJT4n5rsOnJxLM/pZ2vfX1G8vrnvXO8FA==",
  "opencode-darwin-x64-baseline":
    "sha512-rftvAoHBWPVkvwBLr3SQWRZvcIjyMTN0SlhMzlt+lgvoQBBGNEmZQ/7sS/Ux1oHsJV/++UDuLVso4n5L95YD5Q==",
  "opencode-windows-x64":
    "sha512-xCVbrA8A/qQTAdBIKyhK5tx3/mcq18yF82Mi8phry0MJb2631nnnpxF9m6FFfWAVHyer4qFGrO7hbWXesHQ1Gg==",
  "opencode-windows-x64-baseline":
    "sha512-yRHN+TsfLjfLmdQVAVWqTGfGP1yq8YtUFy9Jw33XhlPIp77slBdCJrj2PC4amuEl6BJtaIQDhDFbpJ8+a5z7Qw==",
  "opencode-windows-arm64":
    "sha512-aySF/MDji5KO3I5yl9Ec4g8kW/QIx4Jj5FXwBhh/FrDu0w6L8HAOGH7cyjFb3t8TW7pxRkH3Ei3rfkWAE7cScw==",
});
const MANIFEST = "crot-runtime.json";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL = 16 * 1024;
/** A platform package is about 80 MB packed and 200 MB unpacked; anything far larger is refused. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;

export interface OpenCodeRunResult {
  readonly code: number | null;
  /** The end of the program's output (diagnostics only; never shown to the owner). */
  readonly output: string;
}
/** How CROT runs npm and the installed binary. */
export interface OpenCodeInstallHost {
  /** Whether npm can be started (found on PATH): the fallback when the direct download fails. */
  npm(): Promise<boolean>;
  /** Run npm (a name, found on PATH) or a binary (an absolute path) without a shell, to its end or the deadline. */
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<OpenCodeRunResult>;
  /** The registry of the platform packages (default OPENCODE_REGISTRY; tests use a local one). */
  readonly registry?: string;
  /** sha512 (SRI) per platform package (default OPENCODE_RUNTIME_INTEGRITY; tests pin their own packages). */
  readonly integrity?: Readonly<Record<string, string>>;
}
export interface OpenCodeRuntimeOptions {
  /** <stateDir>/opencode-runtime */
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** A musl Linux (Alpine); default: no glibc in process.report. */
  readonly musl?: boolean;
  /** An x64 CPU with AVX2 (otherwise the baseline builds go first); default: /proc/cpuinfo on Linux, else true. */
  readonly avx2?: boolean;
  readonly host: OpenCodeInstallHost;
  /** False while the emergency stop or an explicit runtime deny forbids starting processes. */
  allowed?(): boolean;
  /** Owner audit of an installation (no secrets, no npm output). */
  record?(outcome: "applied" | "failed", reason?: string): void;
}
export type OpenCodeRuntimeReason =
  "opencode_refused" | "download_failed" | "integrity_mismatch" | "install_failed" | "binary_not_found" | "cancelled";
export interface OpenCodeRuntimeStatus {
  readonly state: "missing" | "installing" | "installed" | "failed";
  readonly version?: string;
  readonly reason?: OpenCodeRuntimeReason;
  /** Installing: the share of the download received so far (0–99), when the registry tells the size. */
  readonly progress?: number;
  /** Failed: what went wrong in a few words (HTTP status, error code, exit code); never secrets. */
  readonly detail?: string;
}
interface Manifest {
  readonly version: string;
  readonly package: string;
  /** The binary, relative to the runtime directory. */
  readonly binary: string;
}

/** opencode-ai's platform packages in the order its postinstall tries them (baseline first without AVX2). */
export function runtimePackages(platform: NodeJS.Platform, arch: string, musl: boolean, avx2 = true): string[] {
  const base = `opencode-${platform === "win32" ? "windows" : platform}-${arch}`;
  const baseline = arch === "x64" && !avx2;
  if (platform === "linux") {
    if (arch === "x64") {
      if (musl)
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }
    return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  }
  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  return [base];
}
const isMusl = (): boolean => {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
};
/** Linux tells the CPU's features; elsewhere the AVX2 build goes first and the baseline one follows if it fails. */
async function hasAvx2(platform: NodeJS.Platform, arch: string): Promise<boolean> {
  if (arch !== "x64" || platform !== "linux") return true;
  try {
    return /(^|\s)avx2(\s|$)/im.test(await readFile("/proc/cpuinfo", "utf8"));
  } catch {
    return true;
  }
}
const isFile = async (file: string): Promise<boolean> => (await stat(file).catch(() => undefined))?.isFile() ?? false;
/** A failed step of the installation: its reason and a few words for the owner. */
class RuntimeFailure extends Error {
  constructor(
    readonly reason: OpenCodeRuntimeReason,
    readonly detail?: string,
  ) {
    super(detail ?? reason);
  }
}
/** A network or HTTP error in a few words: the system's error code, a timeout, or the HTTP status. */
function describe(error: unknown): string {
  if (error instanceof RuntimeFailure) return error.detail ?? error.reason;
  const e = error as { name?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  if (e?.name === "TimeoutError") return "timeout";
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f]+/g, " ").slice(0, 120);
}
const parseNumber = (field: Buffer): number => {
  // GNU base-256 for very large sizes; otherwise octal ASCII ended by NUL or space.
  if (field[0]! & 0x80) return field.subarray(1).reduce((n, byte) => n * 256 + byte, 0);
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text ? parseInt(text, 8) : 0;
};
const tarString = (field: Buffer): string => field.toString("utf8").replace(/\0.*$/s, "");
/**
 * Unpack one regular file (`entry`, e.g. package/bin/opencode) of a .tgz as npm packs it (ustar, pax or GNU
 * long names) to `target`. Only that entry is written, to CROT's own path: no name from the archive is used as
 * a path. False when the archive does not hold it.
 */
export async function extractTarEntry(archive: string, entry: string, target: string): Promise<boolean> {
  const input = createReadStream(archive).pipe(createGunzip());
  let buffer: Buffer = Buffer.alloc(0),
    remaining = 0,
    padding = 0,
    out: WriteStream | undefined,
    meta: Buffer[] | undefined,
    metaType = "",
    nextName: string | undefined,
    found = false;
  const finishData = async () => {
    if (out) {
      out.end();
      await once(out, "close");
      out = undefined;
      found = true;
    } else if (meta) {
      const data = Buffer.concat(meta);
      meta = undefined;
      if (metaType === "L") nextName = tarString(data);
      else nextName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? nextName;
    }
  };
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (remaining > 0) {
          const take = Math.min(remaining, buffer.length);
          if (!take) break;
          const part = buffer.subarray(0, take);
          buffer = buffer.subarray(take);
          remaining -= take;
          if (out) {
            if (!out.write(part)) await once(out, "drain");
          } else if (meta) meta.push(Buffer.from(part));
          if (remaining > 0) break;
          await finishData();
          if (found) return true;
          continue;
        }
        if (padding > 0) {
          const skip = Math.min(padding, buffer.length);
          buffer = buffer.subarray(skip);
          padding -= skip;
          if (padding > 0) break;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) return found;
        const type = String.fromCharCode(header[156]!) || "0",
          size = parseNumber(header.subarray(124, 136)),
          prefix = header.subarray(257, 262).toString("latin1") === "ustar" ? tarString(header.subarray(345, 500)) : "",
          name =
            nextName ??
            (prefix ? `${prefix}/${tarString(header.subarray(0, 100))}` : tarString(header.subarray(0, 100)));
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        if (type === "x" || type === "L") {
          if (size > 1024 * 1024) throw new RuntimeFailure("install_failed", "archive header too large");
          meta = [];
          metaType = type;
        } else {
          nextName = undefined;
          if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === entry) {
            if (size > MAX_BINARY_BYTES) throw new RuntimeFailure("install_failed", "binary too large");
            out = createWriteStream(target, { mode: 0o700 });
            if (!size) await finishData();
            if (found) return true;
          }
        }
        if (!remaining && meta) await finishData();
      }
    }
    return found;
  } finally {
    out?.destroy();
    input.destroy();
  }
}

export class OpenCodeRuntime {
  private job: Promise<OpenCodeRuntimeStatus> | undefined;
  private failure: { reason: OpenCodeRuntimeReason; detail?: string } | undefined;
  private progress: number | undefined;
  private controller = new AbortController();
  private closed = false;
  constructor(private readonly options: OpenCodeRuntimeOptions) {}
  get directory(): string {
    return this.options.directory;
  }
  /** The config, data, state and cache folders of CROT's OpenCode, apart from the owner's own OpenCode. */
  get home(): string {
    return path.join(this.directory, "home");
  }
  private get executable(): string {
    return this.options.platform === "win32" ? "opencode.exe" : "opencode";
  }
  private async manifest(): Promise<Manifest | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, MANIFEST), "utf8")) as Partial<Manifest>;
      if (typeof value.binary !== "string" || typeof value.version !== "string" || typeof value.package !== "string")
        return undefined;
      return value as Manifest;
    } catch {
      return undefined;
    }
  }
  /** The installed binary (absolute), or undefined when CROT has not installed OpenCode. */
  async binary(): Promise<string | undefined> {
    const manifest = await this.manifest();
    if (!manifest) return undefined;
    const file = path.resolve(this.directory, manifest.binary);
    const relative = path.relative(this.directory, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await isFile(file))) return undefined;
    if (this.options.platform !== "win32")
      try {
        await access(file, constants.X_OK);
      } catch {
        return undefined;
      }
    return file;
  }
  async status(): Promise<OpenCodeRuntimeStatus> {
    if (this.job) return { state: "installing", ...(this.progress !== undefined ? { progress: this.progress } : {}) };
    const manifest = (await this.binary()) ? await this.manifest() : undefined;
    if (manifest) return { state: "installed", version: manifest.version };
    return this.failure
      ? {
          state: "failed",
          reason: this.failure.reason,
          ...(this.failure.detail ? { detail: this.failure.detail } : {}),
        }
      : { state: "missing" };
  }
  /** Start the installation in the background (once at a time); the status reports its progress. */
  async start(): Promise<OpenCodeRuntimeStatus> {
    void this.install();
    return this.status();
  }
  /** The installation (the running one, or a new one); resolves with its outcome. */
  install(): Promise<OpenCodeRuntimeStatus> {
    if (this.closed) return Promise.resolve({ state: "failed", reason: "cancelled" });
    return (this.job ??= this.installOnce().finally(() => {
      this.job = undefined;
      this.progress = undefined;
    }));
  }
  private async installOnce(): Promise<OpenCodeRuntimeStatus> {
    this.failure = undefined;
    this.progress = undefined;
    const { host } = this.options,
      dir = this.directory,
      signal = this.controller.signal;
    try {
      if (this.options.allowed && !this.options.allowed()) return this.fail("opencode_refused");
      await mkdir(dir, { recursive: true });
      await rm(path.join(dir, MANIFEST), { force: true });
      const names = runtimePackages(
        this.options.platform,
        this.options.arch,
        this.options.musl ?? isMusl(),
        this.options.avx2 ?? (await hasAvx2(this.options.platform, this.options.arch)),
      );
      const integrity = host.integrity ?? OPENCODE_RUNTIME_INTEGRITY;
      let unreachable: string | undefined, notRunning: string | undefined;
      for (const name of names) {
        const expected = integrity[name];
        if (!expected) continue;
        let file: string;
        try {
          file = await this.download(name, expected, signal);
        } catch (error) {
          if (signal.aborted) return this.fail("cancelled");
          if (error instanceof RuntimeFailure && error.reason !== "download_failed")
            return this.fail(error.reason, error.detail);
          unreachable = describe(error);
          break;
        }
        const check = await host.run(file, ["--version"], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, signal });
        if (signal.aborted) return this.fail("cancelled");
        if (check.code === 0) return await this.installed(name, file, check.output);
        // This build does not run here (e.g. no AVX2): the next variant.
        notRunning = `${name}: --version ${check.code === null ? "did not finish" : `exited with code ${check.code}`}`;
        await rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
      }
      if (unreachable !== undefined) {
        // The download failed (no connection, an HTTP error): npm knows the owner's registry and proxy settings.
        if (await host.npm()) return await this.npmInstall(names, signal, unreachable);
        return this.fail("download_failed", unreachable);
      }
      return this.fail("binary_not_found", notRunning);
    } catch (error) {
      if (signal.aborted) return this.fail("cancelled");
      return error instanceof RuntimeFailure
        ? this.fail(error.reason, error.detail)
        : this.fail("install_failed", describe(error));
    }
  }
  /** One platform package from the registry, checked against its pinned sha512, its binary unpacked to bin/. */
  private async download(name: string, integrity: string, signal: AbortSignal): Promise<string> {
    const registry = (this.options.host.registry ?? OPENCODE_REGISTRY).replace(/\/+$/, "");
    const archive = path.join(this.directory, `${name}.tgz.part`);
    const timeout = AbortSignal.timeout(INSTALL_TIMEOUT_MS);
    const both = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${registry}/${name}/-/${name}-${OPENCODE_RUNTIME_VERSION}.tgz`, { signal: both });
    } catch (error) {
      throw new RuntimeFailure("download_failed", describe(error));
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new RuntimeFailure("download_failed", `HTTP ${response.status}`);
    }
    const total = Number(response.headers.get("content-length")) || 0,
      hash = createHash("sha512"),
      out = createWriteStream(archive, { mode: 0o600 });
    let received = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
        const bytes = chunk as Buffer;
        received += bytes.length;
        if (received > MAX_DOWNLOAD_BYTES) throw new RuntimeFailure("download_failed", "download too large");
        hash.update(bytes);
        if (!out.write(bytes)) await once(out, "drain");
        if (total) this.progress = Math.min(99, Math.floor((received * 100) / total));
      }
      out.end();
      await once(out, "close");
    } catch (error) {
      out.destroy();
      await rm(archive, { force: true }).catch(() => undefined);
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure("download_failed", describe(error));
    }
    try {
      if (`sha512-${hash.digest("base64")}` !== integrity)
        throw new RuntimeFailure("integrity_mismatch", `${name}: sha512 differs from the published one`);
      // A folder of its own per installation: a binary still running from an earlier one is never overwritten.
      const folder = path.join(this.directory, "bin", `${name}-${Date.now().toString(36)}`),
        binary = path.join(folder, this.executable);
      await mkdir(folder, { recursive: true });
      if (!(await extractTarEntry(archive, `package/bin/${this.executable}`, binary))) {
        await rm(folder, { recursive: true, force: true });
        throw new RuntimeFailure("binary_not_found", `${name}: no bin/${this.executable} in the package`);
      }
      if (this.options.platform !== "win32") await chmod(binary, 0o755);
      return binary;
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
    }
  }
  /** The binary that answered `--version`: recorded in the manifest; earlier installations are removed. */
  private async installed(name: string, file: string, output: string): Promise<OpenCodeRuntimeStatus> {
    const dir = this.directory;
    const manifest: Manifest = {
      version: /^\d+\.\d+\.\d+[\w.+-]*$/.exec(output.trim())?.[0] ?? OPENCODE_RUNTIME_VERSION,
      package: name,
      binary: path.relative(dir, file),
    };
    await writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest)}\n`);
    await this.prune(file);
    this.options.record?.("applied");
    return { state: "installed", version: manifest.version };
  }
  /** The fallback through npm: the pinned opencode-ai into the runtime directory, without package scripts. */
  private async npmInstall(names: readonly string[], signal: AbortSignal, unreachable: string) {
    const { host } = this.options,
      dir = this.directory;
    // An own package.json: npm installs here and never into a project further up.
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "crot-opencode-runtime", private: true, description: "OpenCode installed by CROT" })}\n`,
    );
    const npm = await host.run(
      "npm",
      [
        "install",
        "--prefix",
        dir,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-update-notifier",
        "--loglevel=error",
        "--save-exact",
        `${OPENCODE_RUNTIME_PACKAGE}@${OPENCODE_RUNTIME_VERSION}`,
      ],
      { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS, signal },
    );
    if (signal.aborted) return this.fail("cancelled");
    if (npm.code !== 0) return this.fail("install_failed", `${unreachable}; npm exited with code ${npm.code ?? "?"}`);
    for (const name of names) {
      const file = path.join(dir, "node_modules", name, "bin", this.executable);
      if (!(await isFile(file))) continue;
      const check = await host.run(file, ["--version"], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, signal });
      if (signal.aborted) return this.fail("cancelled");
      if (check.code === 0) return this.installed(name, file, check.output);
    }
    return this.fail("binary_not_found");
  }
  /** Everything but the binary in use: other variants npm installed (about 200 MB each), earlier downloads. */
  private async prune(keep: string): Promise<void> {
    const dir = this.directory,
      keepFolder = path.dirname(keep),
      viaNpm = keep.startsWith(path.join(dir, "node_modules") + path.sep);
    const prefix = `opencode-${this.options.platform === "win32" ? "windows" : this.options.platform}-`;
    const remove = (file: string) => rm(file, { recursive: true, force: true }).catch(() => undefined);
    for (const name of await readdir(path.join(dir, "bin")).catch(() => [] as string[]))
      if (path.join(dir, "bin", name) !== keepFolder) await remove(path.join(dir, "bin", name));
    if (!viaNpm) {
      for (const name of ["node_modules", "package.json", "package-lock.json"]) await remove(path.join(dir, name));
      return;
    }
    const modules = path.join(dir, "node_modules");
    for (const name of await readdir(modules).catch(() => [] as string[]))
      if (name.startsWith(prefix) && !keep.startsWith(path.join(modules, name) + path.sep))
        await remove(path.join(modules, name));
  }
  private fail(reason: OpenCodeRuntimeReason, detail?: string): OpenCodeRuntimeStatus {
    this.failure = { reason, ...(detail ? { detail } : {}) };
    this.options.record?.("failed", reason);
    return { state: "failed", reason, ...(detail ? { detail } : {}) };
  }
  /** Stop a running installation (emergency stop); a later start installs again. */
  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    await this.job?.catch(() => undefined);
  }
}

/**
 * Run a program to its end without a shell (OpenCodeInstallHost.run): a name is resolved on the absolute PATH
 * entries (npm, npm.cmd through cmd.exe on Windows), an absolute path is started as is. At the deadline or on
 * `signal` the process tree is terminated.
 */
export async function runProgram(
  launcher: ProcessLauncher,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number; signal?: AbortSignal },
): Promise<OpenCodeRunResult> {
  const { cwd, env, timeoutMs, signal } = options;
  if (signal?.aborted) return { code: null, output: "" };
  const spec = path.isAbsolute(command)
    ? { file: command, args, display: [command, ...args].join(" ") }
    : await launcher.resolveCommand(command, args, { cwd, env, searchCurrentDirectory: false });
  const proc = await launcher.launch(spec, { cwd, env, stdin: false });
  let output = "";
  const keep = (chunk: Buffer | string) => {
    output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
  };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  const stop = () => void proc.terminate("force").catch(() => undefined);
  // CROT exiting mid-install: npm and its children go with it.
  const exitHook = () => proc.terminateSync();
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  process.once("exit", exitHook);
  try {
    const status = await proc.exited;
    return { code: status.code, output };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    process.removeListener("exit", exitHook);
  }
}
