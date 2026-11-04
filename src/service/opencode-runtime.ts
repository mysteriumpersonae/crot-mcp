/**
 * OpenCode installed by CROT ("Install and start OpenCode"), for owners without an `opencode` of their own:
 * npm installs the pinned opencode-ai package into <stateDir>/opencode-runtime without running package
 * scripts (--ignore-scripts). CROT then picks the platform binary that runs here the way opencode-ai's own
 * postinstall would (opencode-<os>-<arch>[-musl][-baseline]: the first one that answers `--version`), records
 * it in crot-runtime.json and removes the other variants. The bridge starts it when no `opencode` is installed.
 *
 * npm and the binary check are control-plane helpers like the bridge: started by the owner, with the
 * allowlisted child environment, refused by the emergency stop or an explicit runtime deny of process.start.
 */
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessLauncher } from "../core/platform/types.js";

export const OPENCODE_RUNTIME_PACKAGE = "opencode-ai";
/** The OpenCode version CROT installs (the one CROT's bridge is tested with). */
export const OPENCODE_RUNTIME_VERSION = "1.19.5";
const MANIFEST = "crot-runtime.json";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL = 16 * 1024;

export interface OpenCodeRunResult {
  readonly code: number | null;
  /** The end of the program's output (diagnostics only; never shown to the owner). */
  readonly output: string;
}
/** How CROT runs npm and the installed binary. */
export interface OpenCodeInstallHost {
  /** Whether npm can be started (found on PATH). */
  npm(): Promise<boolean>;
  /** Run npm (a name, found on PATH) or a binary (an absolute path) without a shell, to its end or the deadline. */
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<OpenCodeRunResult>;
}
export interface OpenCodeRuntimeOptions {
  /** <stateDir>/opencode-runtime */
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** A musl Linux (Alpine); default: no glibc in process.report. */
  readonly musl?: boolean;
  readonly host: OpenCodeInstallHost;
  /** False while the emergency stop or an explicit runtime deny forbids starting processes. */
  allowed?(): boolean;
  /** Owner audit of an installation (no secrets, no npm output). */
  record?(outcome: "applied" | "failed", reason?: string): void;
}
export type OpenCodeRuntimeReason =
  "opencode_refused" | "npm_not_found" | "install_failed" | "binary_not_found" | "cancelled";
export interface OpenCodeRuntimeStatus {
  readonly state: "missing" | "installing" | "installed" | "failed";
  readonly version?: string;
  readonly reason?: OpenCodeRuntimeReason;
}
interface Manifest {
  readonly version: string;
  readonly package: string;
  /** The binary, relative to the runtime directory. */
  readonly binary: string;
}

/** opencode-ai's platform packages in the order its postinstall tries them on a CPU with AVX2. */
export function runtimePackages(platform: NodeJS.Platform, arch: string, musl: boolean): string[] {
  const base = `opencode-${platform === "win32" ? "windows" : platform}-${arch}`;
  if (platform === "linux") {
    if (arch === "x64")
      return musl
        ? [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    return musl ? [`${base}-musl`, base] : [base, `${base}-musl`];
  }
  return arch === "x64" ? [base, `${base}-baseline`] : [base];
}
const isMusl = (): boolean => {
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
};
const isFile = async (file: string): Promise<boolean> => (await stat(file).catch(() => undefined))?.isFile() ?? false;

export class OpenCodeRuntime {
  private job: Promise<OpenCodeRuntimeStatus> | undefined;
  private failure: OpenCodeRuntimeReason | undefined;
  private controller = new AbortController();
  private closed = false;
  constructor(private readonly options: OpenCodeRuntimeOptions) {}
  get directory(): string {
    return this.options.directory;
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
    if (this.job) return { state: "installing" };
    const manifest = (await this.binary()) ? await this.manifest() : undefined;
    if (manifest) return { state: "installed", version: manifest.version };
    return this.failure ? { state: "failed", reason: this.failure } : { state: "missing" };
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
    }));
  }
  private async installOnce(): Promise<OpenCodeRuntimeStatus> {
    this.failure = undefined;
    const { host } = this.options,
      dir = this.directory,
      signal = this.controller.signal;
    try {
      if (this.options.allowed && !this.options.allowed()) return this.fail("opencode_refused");
      if (!(await host.npm())) return this.fail("npm_not_found");
      await mkdir(dir, { recursive: true });
      await rm(path.join(dir, MANIFEST), { force: true });
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
      if (npm.code !== 0) return this.fail("install_failed");
      const names = runtimePackages(this.options.platform, this.options.arch, this.options.musl ?? isMusl());
      for (const name of names) {
        const file = path.join(dir, "node_modules", name, "bin", this.executable);
        if (!(await isFile(file))) continue;
        const check = await host.run(file, ["--version"], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, signal });
        if (signal.aborted) return this.fail("cancelled");
        if (check.code !== 0) continue;
        const manifest: Manifest = {
          version: /^\d+\.\d+\.\d+[\w.+-]*$/.exec(check.output.trim())?.[0] ?? OPENCODE_RUNTIME_VERSION,
          package: name,
          binary: path.relative(dir, file),
        };
        await this.prune(name);
        await writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest)}\n`);
        this.options.record?.("applied");
        return { state: "installed", version: manifest.version };
      }
      return this.fail("binary_not_found");
    } catch {
      return this.fail(signal.aborted ? "cancelled" : "install_failed");
    }
  }
  /** The other platform variants npm installed (about 200 MB each). */
  private async prune(keep: string): Promise<void> {
    const prefix = `opencode-${this.options.platform === "win32" ? "windows" : this.options.platform}-`;
    const modules = path.join(this.directory, "node_modules");
    for (const name of await readdir(modules).catch(() => [] as string[]))
      if (name.startsWith(prefix) && name !== keep)
        await rm(path.join(modules, name), { recursive: true, force: true }).catch(() => undefined);
  }
  private fail(reason: OpenCodeRuntimeReason): OpenCodeRuntimeStatus {
    this.failure = reason;
    this.options.record?.("failed", reason);
    return { state: "failed", reason };
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
