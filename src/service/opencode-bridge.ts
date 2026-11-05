/**
 * The local OpenCode bridge: CROT's own `opencode serve` on 127.0.0.1, started when the owner connects
 * OpenCode without a key (Cloud LLM "OpenCode (Free & Zen)") or chooses "Start and connect OpenCode"
 * (Workspaces), and stopped with CROT. A random password protects it (OPENCODE_SERVER_PASSWORD, HTTP Basic).
 * An OpenCode server the owner already runs on the default port without a password is used as is and
 * never stopped by CROT.
 *
 * The server is a control-plane helper like the provider requests of chat-runtime: the owner starts it, it
 * gets the allowlisted child environment (no CROT service secrets) and a CROT-owned working directory, and
 * the emergency stop or an explicit runtime deny of process.start refuses it. Of its output only a short tail
 * is kept, for the owner's explanation of a failed start (one redacted line, see openCodeDetail).
 *
 * Which OpenCode: the owner's own `opencode` first; when it does not start (too old, broken installation,
 * crash, no answer), the copy CROT installed (opencode-runtime.ts) in its own config, data, state and cache
 * folders, so it never touches the owner's OpenCode. Why the last start failed stays in status() (`problem`):
 * the UI offers the one-click install of CROT's verified OpenCode with the exact reason.
 *
 * It never outlives CROT: close() stops it (the service's shutdown on SIGINT/SIGTERM/SIGHUP), terminateSync()
 * kills it on the emergency and 'exit' paths, and its PID file (opencode-pid.ts) lets the next start stop a
 * server that a killed or crashed CROT left behind before a new one starts.
 */
import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CrotError } from "../core/errors.js";
import { createEnvironmentPolicy } from "../core/platform/environment.js";
import type { ExitStatus, ManagedProcess } from "../core/platform/types.js";
import { findOpenCodeBinary, type OpenCodeLocal } from "./opencode-local.js";
import { BridgePidFile, nodeBridgeProcesses, type BridgeProcesses } from "./opencode-pid.js";
import { openCodeDetail } from "./workspace-chat.js";

export const OPENCODE_DEFAULT_PORT = 4096;
export const OPENCODE_USERNAME = "opencode";
/** The install command shown when OpenCode is missing (https://opencode.ai/docs). */
export const OPENCODE_INSTALL_COMMAND = "npm i -g opencode-ai";
/** The oldest OpenCode whose server CROT can use: 1.0 brought /global/health and /provider (0.x has neither). */
export const OPENCODE_MIN_VERSION = "1.0.0";
const READY_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 15_000;
/** A server that keeps refusing CROT's password (HTTP 401) is not CROT's: given up after this long. */
const UNAUTHORIZED_MS = 5_000;
const OUTPUT_TAIL = 4096;

/** A running OpenCode server. The password stays in the service; status reports only url/managed/version. */
export interface OpenCodeServer {
  readonly url: string;
  /** Started by CROT (and stopped with it); false: the owner's own server on the default port. */
  readonly managed: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly version?: string;
  /** A managed server: the owner's own OpenCode, or the copy CROT installed. */
  readonly source?: "owner" | "crot";
}
export interface OpenCodeCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Whose OpenCode: the owner's own (default) or the copy CROT installed. */
  readonly source?: "owner" | "crot";
  /** Its own environment on top of the bridge's (CROT's copy: its own XDG config, data, state, cache). */
  readonly env?: Readonly<Record<string, string>>;
}
/** Why the last start of local OpenCode failed (cleared by the next successful start). */
export interface OpenCodeProblem {
  readonly code: "OPENCODE_START_FAILED" | "OPENCODE_TOO_OLD";
  /** The owner's own OpenCode, or the copy CROT installed. */
  readonly source: "owner" | "crot";
  readonly version?: string;
  /** One redacted line: the exit code and OpenCode's last error line, the HTTP status, or the wait. */
  readonly detail?: string;
}
export interface OpenCodeBridgeOptions {
  readonly local: OpenCodeLocal;
  /** Start the server process without a shell; the bridge stops it with terminate(). */
  launch(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string> },
  ): Promise<ManagedProcess>;
  /** The server's environment: the allowlisted child environment (no CROT service secrets). */
  readonly env: Readonly<Record<string, string>>;
  /** The server's working directory and the directory of model-only turns: empty and CROT-owned. */
  readonly directory: string;
  /** False while the emergency stop or an explicit runtime deny forbids starting processes. */
  allowed?(): boolean;
  /** Owner audit of the server's start, stop, unexpected exit and a left-behind server stopped (no secrets). */
  record?(event: "start" | "stop" | "exit" | "reap", outcome: "applied" | "failed"): void;
  /** Default 4096 (OpenCode's own default). */
  readonly port?: number;
  /** The command that runs the owner's OpenCode; default: the discovered `opencode` binary. */
  command?(): Promise<OpenCodeCommand | undefined>;
  /**
   * OpenCode installed by CROT (opencode-runtime.ts): started when the owner has none or theirs does not start,
   * with its own config, data, state and cache folders under `home`.
   */
  readonly runtime?: { binary(): Promise<string | undefined>; readonly home?: string };
  /** Tests: the command that runs CROT's installed OpenCode; default: its binary. */
  runtimeCommand?(): Promise<OpenCodeCommand | undefined>;
  /** <stateDir>/opencode-bridge.pid: the running server, so a later start stops one left behind. */
  readonly pidFile?: string;
  /** Process inspection for the PID file; default: the operating system's. */
  readonly processes?: BridgeProcesses;
  readonly readyTimeoutMs?: number;
}
export interface OpenCodeBridgeStatus {
  readonly installed: boolean;
  readonly server?: { url: string; managed: boolean; version?: string; source?: "owner" | "crot" };
  /** Why the last start failed, while no server runs. */
  readonly problem?: OpenCodeProblem;
}

interface Health {
  readonly healthy: boolean;
  readonly status: number | "refused" | "error";
  readonly version?: string;
}
async function health(url: string, authorization?: string, timeoutMs = 1500): Promise<Health> {
  try {
    const response = await fetch(`${url}/global/health`, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (response.status !== 200) return { healthy: false, status: response.status };
    const value = JSON.parse(body) as Record<string, unknown>;
    const version = typeof value.version === "string" && /^[\w.+-]{1,64}$/.test(value.version) ? value.version : "";
    return { healthy: value.healthy === true, status: 200, ...(version ? { version } : {}) };
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return { healthy: false, status: code === "ECONNREFUSED" ? "refused" : "error" };
  }
}
export const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
/** "1.19.5" → [1, 19, 5]; undefined for anything else. */
const versionParts = (version: string | undefined): number[] | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};
export const olderThan = (version: string, minimum: string): boolean => {
  const a = versionParts(version),
    b = versionParts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};
/** The binary as the owner knows it: the home folder as ~. */
function shortPath(file: string, home: string | undefined): string {
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}
const ERROR_LINE =
  /error|fail|invalid|cannot|can't|unable|not found|denied|refused|panic|exception|illegal|EADDRINUSE|EACCES|ENOENT/i;
/** OpenCode's last error line in its output (else its last line), without colour codes. */
export function lastOutputLine(output: string, secret?: string): string | undefined {
  const lines = (secret ? output.split(secret).join("[redacted]") : output)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => ERROR_LINE.test(line)) ?? lines.at(-1);
}
const exitText = (status: ExitStatus): string =>
  status.signal ? `stopped by ${status.signal}` : `exited with code ${status.code ?? "?"}`;
/** Stands for the program in a detail until it is redacted: its path is the owner's own, never taken for a token. */
const PROGRAM = "\u2039opencode\u203a";
function programDetail(text: string, program: string): string | undefined {
  const line = openCodeDetail(text)?.split(PROGRAM).join(program);
  return line && line.length > 300 ? `${line.slice(0, 299)}…` : line;
}
const startFailed = (source: "owner" | "crot", detail?: string, exited = false) =>
  new CrotError("OPERATION_FAILED", "OpenCode could not be started", {
    stage: "local",
    reason: "opencode_start_failed",
    source,
    ...(exited ? { exited: true } : {}),
    ...(detail ? { detail } : {}),
  });
const startProblem = (error: unknown): error is CrotError =>
  error instanceof CrotError &&
  (error.details?.reason === "opencode_start_failed" || error.details?.reason === "opencode_too_old");
/** Stop waiting when `signal` aborts; the shared start itself goes on for other callers. */
function until<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new CrotError("OPERATION_FAILED", "Cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CrotError("OPERATION_FAILED", "Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class OpenCodeBridge {
  private server: (OpenCodeServer & { proc?: ManagedProcess }) | undefined;
  private starting: Promise<OpenCodeServer> | undefined;
  private closed = false;
  private problem: OpenCodeProblem | undefined;
  /** OpenCode programs that failed to start, by path, size and change time: skipped while another one exists. */
  private readonly failed = new Map<string, CrotError>();
  private hooked = false;
  private reaping: Promise<boolean> | undefined;
  private readonly pid: BridgePidFile | undefined;
  /** CROT exiting without close(): the managed server goes with it. */
  private readonly exitHook = () => this.terminateSync();
  constructor(private readonly options: OpenCodeBridgeOptions) {
    this.pid = options.pidFile
      ? new BridgePidFile(
          options.pidFile,
          options.processes ?? nodeBridgeProcesses(options.local.platform),
          options.local.platform,
        )
      : undefined;
  }
  get directory(): string {
    return this.options.directory;
  }
  private get port(): number {
    return this.options.port ?? OPENCODE_DEFAULT_PORT;
  }
  /** The OpenCode programs to start, in order: the owner's own `opencode`, then the copy CROT installed. */
  async commands(): Promise<OpenCodeCommand[]> {
    const own = this.options.command
      ? await this.options.command()
      : await findOpenCodeBinary(this.options.local).then((binary) =>
          binary ? { command: binary, args: [] } : undefined,
        );
    const crot = this.options.runtimeCommand
      ? await this.options.runtimeCommand()
      : await this.options.runtime?.binary().then((binary) => (binary ? { command: binary, args: [] } : undefined));
    const out: OpenCodeCommand[] = own ? [{ ...own, source: "owner" }] : [];
    const same = own && crot && own.command === crot.command && own.args.join("\0") === crot.args.join("\0");
    if (crot && !same) out.push({ ...crot, source: "crot", env: this.runtimeEnvironment() });
    return out;
  }
  /** The command that starts OpenCode first, or undefined when OpenCode is not installed. */
  async command(): Promise<OpenCodeCommand | undefined> {
    return (await this.commands())[0];
  }
  async installed(): Promise<boolean> {
    return (await this.commands().catch(() => [])).length > 0;
  }
  /** CROT's copy keeps its config, data, state and cache apart from the owner's OpenCode. */
  private runtimeEnvironment(): Record<string, string> {
    const home = this.options.runtime?.home;
    if (!home) return {};
    return {
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
    };
  }
  /** The server in use while it runs (a managed one until its process exits). */
  current(): OpenCodeServer | undefined {
    if (this.server?.proc?.hasExited) this.server = undefined;
    return this.server;
  }
  /** Installed binary and the running server (CROT's own, or the owner's on the default port). */
  async status(): Promise<OpenCodeBridgeStatus> {
    const installed = await this.installed();
    let server: OpenCodeServer | undefined = this.current(),
      version = server?.version;
    if (server && !server.managed && !(await health(server.url)).healthy) server = undefined;
    if (!server) {
      const url = `http://127.0.0.1:${this.port}`,
        probe = await health(url);
      if (probe.healthy) {
        server = { url, managed: false };
        version = probe.version;
      }
    }
    return {
      installed,
      ...(server
        ? {
            server: {
              url: server.url,
              managed: server.managed,
              ...(version ? { version } : {}),
              ...(server.managed && server.source ? { source: server.source } : {}),
            },
          }
        : {}),
      ...(!server && this.problem ? { problem: this.problem } : {}),
    };
  }
  /** A running OpenCode server: the current one, the owner's unprotected one on the default port, or a new one. */
  async ensure(signal?: AbortSignal): Promise<OpenCodeServer> {
    if (this.closed) throw new CrotError("OPERATION_FAILED", "OpenCode bridge is closed");
    await mkdir(this.options.directory, { recursive: true });
    const current = this.current();
    if (current?.managed) return current;
    const start = (this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    }));
    return until(start, signal);
  }
  /**
   * Stop the server a previous CROT left running (its PID file), once per bridge: at the service start and
   * before the first server starts. True when one was stopped.
   */
  reap(): Promise<boolean> {
    return (this.reaping ??= (this.pid?.reap() ?? Promise.resolve(false)).then(
      (stopped) => {
        if (stopped) this.options.record?.("reap", "applied");
        return stopped;
      },
      () => false,
    ));
  }
  private async open(): Promise<OpenCodeServer> {
    // A server left behind holds its port (often the default one) and would run on: it goes first.
    await this.reap();
    const current = this.current();
    if (current && (await health(current.url)).healthy) return current;
    this.server = undefined;
    const url = `http://127.0.0.1:${this.port}`,
      probe = await health(url);
    if (probe.healthy)
      return (this.server = { url, managed: false, ...(probe.version ? { version: probe.version } : {}) });
    const commands = await this.commands();
    if (!commands.length)
      throw new CrotError("NOT_FOUND", "OpenCode CLI is not installed", {
        stage: "local",
        reason: "opencode_not_installed",
      });
    if (this.options.allowed && !this.options.allowed())
      throw new CrotError("PERMISSION_DENIED", "Starting OpenCode is not allowed now", {
        stage: "local",
        reason: "opencode_refused",
      });
    // The owner's OpenCode first, unless it failed before and is unchanged; then CROT's own copy.
    let failure: CrotError | undefined;
    for (const [index, command] of commands.entries()) {
      const key = await this.fingerprint(command),
        known = this.failed.get(key);
      if (known && index < commands.length - 1) {
        failure = known;
        continue;
      }
      try {
        const server = await this.start(command, probe.status === "refused");
        this.failed.delete(key);
        this.problem = undefined;
        return server;
      } catch (error) {
        if (!startProblem(error) || this.closed) throw error;
        this.failed.set(key, error);
        failure = error;
        const d = error.details ?? {};
        this.problem = {
          code: d.reason === "opencode_too_old" ? "OPENCODE_TOO_OLD" : "OPENCODE_START_FAILED",
          source: command.source ?? "owner",
          ...(typeof d.version === "string" ? { version: d.version } : {}),
          ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
        };
      }
    }
    throw failure!;
  }
  /** The program, its size and change time: a reinstalled or updated OpenCode is tried again. */
  private async fingerprint(command: OpenCodeCommand): Promise<string> {
    const info = await stat(command.command).catch(() => undefined);
    return JSON.stringify([command.command, command.args, info?.size, info?.mtimeMs]);
  }
  private async start(command: OpenCodeCommand, defaultPortFree: boolean): Promise<OpenCodeServer> {
    // The default port when it is free; a port taken by another program or a protected server: any free one.
    const port = defaultPortFree ? this.port : await freePort();
    try {
      return await this.spawn(command, port);
    } catch (error) {
      // The port was taken in between: once more on a free one.
      if (port === this.port && error instanceof CrotError && error.details?.exited && !this.closed)
        return this.spawn(command, await freePort());
      throw error;
    }
  }
  /** `opencode --version` (for the explanation of an OpenCode too old for CROT). */
  private async version(command: OpenCodeCommand, env: Record<string, string>): Promise<string | undefined> {
    try {
      const proc = await this.options.launch(command.command, [...command.args, "--version"], {
        cwd: this.options.directory,
        env,
      });
      let output = "";
      proc.stdout.on("data", (chunk: Buffer | string) => (output = (output + chunk.toString()).slice(-256)));
      proc.stderr.resume();
      const done = await Promise.race([proc.exited.then(() => true), delay(VERSION_TIMEOUT_MS).then(() => false)]);
      if (!done) await proc.terminate("force").catch(() => undefined);
      return /\b(\d+\.\d+\.\d+[\w.+-]*)/.exec(output)?.[1];
    } catch {
      return undefined;
    }
  }
  private async spawn(command: OpenCodeCommand, port: number): Promise<OpenCodeServer> {
    const password = randomBytes(24).toString("base64url"),
      source = command.source ?? "owner",
      who = shortPath(command.command, this.options.local.home),
      explain = (text: string) => programDetail(text, who);
    const env = createEnvironmentPolicy(this.options.local.platform === "win32").merge(this.options.env, {
      ...command.env,
      OPENCODE_SERVER_USERNAME: OPENCODE_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    });
    for (const [name, folder] of Object.entries(command.env ?? {}))
      if (name.startsWith("XDG_")) await mkdir(folder, { recursive: true }).catch(() => undefined);
    let proc: ManagedProcess;
    try {
      proc = await this.options.launch(
        command.command,
        [...command.args, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: this.options.directory, env },
      );
    } catch (error) {
      this.options.record?.("start", "failed");
      const message = error instanceof Error ? error.message : String(error);
      throw startFailed(source, explain(`${PROGRAM}: ${message.split(command.command).join(PROGRAM)}`));
    }
    // A short tail of its output: the owner's explanation when it does not start.
    let output = "";
    const keep = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    this.hook(true);
    if (proc.pid)
      await this.pid
        ?.write({ pid: proc.pid, port, command: command.command, startedAt: new Date().toISOString() })
        .catch(() => undefined);
    const url = `http://127.0.0.1:${port}`,
      authorization = basicAuthorization(OPENCODE_USERNAME, password),
      timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      deadline = Date.now() + timeoutMs,
      line = () => lastOutputLine(output, password);
    let version: string | undefined, unauthorized: number | undefined, last: Health | undefined;
    try {
      for (;;) {
        if (this.closed) throw startFailed(source);
        if (proc.hasExited) {
          const status = await proc.exited;
          throw startFailed(source, explain(`${PROGRAM}: ${exitText(status)}${line() ? ` — ${line()}` : ""}`), true);
        }
        const ready = await health(url, authorization);
        if (ready.healthy) {
          version = ready.version;
          break;
        }
        if (ready.status === 404) {
          // OpenCode 0.x answers, but has no /global/health (nor the rest of the API CROT uses).
          const found = await this.version(command, env);
          if (found && olderThan(found, OPENCODE_MIN_VERSION))
            throw new CrotError("OPERATION_FAILED", "OpenCode is too old", {
              stage: "local",
              reason: "opencode_too_old",
              source,
              version: found,
              detail: explain(`${PROGRAM} ${found}: CROT needs OpenCode ${OPENCODE_MIN_VERSION} or newer`),
            });
          throw startFailed(source, explain(`${PROGRAM}${found ? ` ${found}` : ""}: HTTP 404 on /global/health`));
        }
        if (ready.status === 401) {
          unauthorized ??= Date.now();
          if (Date.now() - unauthorized > UNAUTHORIZED_MS)
            throw startFailed(source, explain(`${PROGRAM}: HTTP 401 — OpenCode did not accept CROT's server password`));
        }
        last = ready;
        if (Date.now() >= deadline) {
          const answer = typeof last.status === "number" ? `, last answer HTTP ${last.status}` : "";
          throw startFailed(
            source,
            explain(
              `${PROGRAM}: no answer within ${Math.round(timeoutMs / 1000)} s${answer}${line() ? ` — ${line()}` : ""}`,
            ),
          );
        }
        await delay(150);
      }
    } catch (error) {
      await this.terminate(proc);
      this.options.record?.("start", "failed");
      throw error;
    }
    const server = {
      url,
      managed: true,
      username: OPENCODE_USERNAME,
      password,
      ...(version ? { version } : {}),
      source,
      proc,
    };
    this.server = server;
    this.options.record?.("start", "applied");
    void proc.exited.then(() => {
      void this.pid?.clear(proc.pid);
      if (this.server !== server) return;
      this.server = undefined;
      this.hook(false);
      this.options.record?.("exit", "applied");
    });
    return server;
  }
  private hook(on: boolean): void {
    if (on === this.hooked) return;
    this.hooked = on;
    if (on) process.on("exit", this.exitHook);
    else process.off("exit", this.exitHook);
  }
  private async terminate(proc: ManagedProcess): Promise<void> {
    // Windows console programs ignore a graceful request; POSIX servers get SIGTERM and 3 s to exit.
    if (!proc.hasExited && this.options.local.platform !== "win32") {
      await proc.terminate("graceful").catch(() => undefined);
      await Promise.race([proc.exited, delay(3000)]);
    }
    // The rest of the tree (descendants may outlive the server).
    await proc.terminate("force").catch(() => undefined);
    await Promise.race([proc.exited, delay(3000)]);
    await this.pid?.clear(proc.pid);
    if (!this.server?.proc) this.hook(false);
  }
  /** Kill CROT's own server at once (CROT's emergency and 'exit' paths), without waiting. */
  terminateSync(): void {
    const proc = this.server?.proc;
    if (!proc) return;
    proc.terminateSync();
    this.pid?.clearSync(proc.pid);
  }
  /** Stop CROT's own server (an owner's server is only forgotten). True when a server was stopped. */
  async stop(): Promise<boolean> {
    if (this.starting) await this.starting.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    if (!server?.proc) return false;
    await this.terminate(server.proc);
    this.hook(false);
    this.options.record?.("stop", "applied");
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
  }
}
