/**
 * The local OpenCode bridge: CROT's own `opencode serve` on 127.0.0.1, started when the owner connects
 * OpenCode without a key (Cloud LLM "OpenCode (Free & Zen)") or chooses "Start and connect OpenCode"
 * (Workspaces), and stopped with CROT. A random password protects it (OPENCODE_SERVER_PASSWORD, HTTP Basic).
 * An OpenCode server the owner already runs on the default port without a password is used as is and
 * never stopped by CROT.
 *
 * The server is a control-plane helper like the provider requests of chat-runtime: the owner starts it, it
 * gets the allowlisted child environment (no CROT service secrets) and a CROT-owned working directory, and
 * the emergency stop or an explicit runtime deny of process.start refuses it. Its output is never read.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CrotError } from "../core/errors.js";
import { createEnvironmentPolicy } from "../core/platform/environment.js";
import type { ManagedProcess } from "../core/platform/types.js";
import { findOpenCodeBinary, type OpenCodeLocal } from "./opencode-local.js";

export const OPENCODE_DEFAULT_PORT = 4096;
export const OPENCODE_USERNAME = "opencode";
/** The install command shown when OpenCode is missing (https://opencode.ai/docs). */
export const OPENCODE_INSTALL_COMMAND = "npm i -g opencode-ai";

/** A running OpenCode server. The password stays in the service; status reports only url/managed/version. */
export interface OpenCodeServer {
  readonly url: string;
  /** Started by CROT (and stopped with it); false: the owner's own server on the default port. */
  readonly managed: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly version?: string;
}
export interface OpenCodeCommand {
  readonly command: string;
  readonly args: readonly string[];
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
  /** Owner audit of the server's start, stop and unexpected exit (no secrets). */
  record?(event: "start" | "stop" | "exit", outcome: "applied" | "failed"): void;
  /** Default 4096 (OpenCode's own default). */
  readonly port?: number;
  /** The command that runs OpenCode; default: the discovered `opencode` binary. */
  command?(): Promise<OpenCodeCommand | undefined>;
  readonly readyTimeoutMs?: number;
}
export interface OpenCodeBridgeStatus {
  readonly installed: boolean;
  readonly server?: { url: string; managed: boolean; version?: string };
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
const startFailed = (exited = false) =>
  new CrotError("OPERATION_FAILED", "OpenCode could not be started", {
    stage: "local",
    reason: "opencode_start_failed",
    ...(exited ? { exited: true } : {}),
  });
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
  private hooked = false;
  /** CROT exiting without close(): the managed server goes with it. */
  private readonly exitHook = () => this.server?.proc?.terminateSync();
  constructor(private readonly options: OpenCodeBridgeOptions) {}
  get directory(): string {
    return this.options.directory;
  }
  private get port(): number {
    return this.options.port ?? OPENCODE_DEFAULT_PORT;
  }
  /** The command that starts OpenCode, or undefined when OpenCode is not installed. */
  async command(): Promise<OpenCodeCommand | undefined> {
    if (this.options.command) return this.options.command();
    const binary = await findOpenCodeBinary(this.options.local);
    return binary ? { command: binary, args: [] } : undefined;
  }
  async installed(): Promise<boolean> {
    return !!(await this.command().catch(() => undefined));
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
      ...(server ? { server: { url: server.url, managed: server.managed, ...(version ? { version } : {}) } } : {}),
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
  private async open(): Promise<OpenCodeServer> {
    const current = this.current();
    if (current && (await health(current.url)).healthy) return current;
    this.server = undefined;
    const url = `http://127.0.0.1:${this.port}`,
      probe = await health(url);
    if (probe.healthy)
      return (this.server = { url, managed: false, ...(probe.version ? { version: probe.version } : {}) });
    const command = await this.command();
    if (!command)
      throw new CrotError("NOT_FOUND", "OpenCode CLI is not installed", {
        stage: "local",
        reason: "opencode_not_installed",
      });
    if (this.options.allowed && !this.options.allowed())
      throw new CrotError("PERMISSION_DENIED", "Starting OpenCode is not allowed now", {
        stage: "local",
        reason: "opencode_refused",
      });
    // The default port when it is free; a port taken by another program or a protected server: any free one.
    const port = probe.status === "refused" ? this.port : await freePort();
    try {
      return await this.spawn(command, port);
    } catch (error) {
      // The port was taken in between: once more on a free one.
      if (port === this.port && error instanceof CrotError && error.details?.exited && !this.closed)
        return this.spawn(command, await freePort());
      throw error;
    }
  }
  private async spawn(command: OpenCodeCommand, port: number): Promise<OpenCodeServer> {
    const password = randomBytes(24).toString("base64url");
    const env = createEnvironmentPolicy(this.options.local.platform === "win32").merge(this.options.env, {
      OPENCODE_SERVER_USERNAME: OPENCODE_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    });
    let proc: ManagedProcess;
    try {
      proc = await this.options.launch(
        command.command,
        [...command.args, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: this.options.directory, env },
      );
    } catch {
      this.options.record?.("start", "failed");
      throw startFailed();
    }
    proc.stdout.resume();
    proc.stderr.resume();
    this.hook(true);
    const url = `http://127.0.0.1:${port}`,
      authorization = basicAuthorization(OPENCODE_USERNAME, password),
      deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    let version: string | undefined;
    try {
      for (;;) {
        if (this.closed) throw startFailed();
        if (proc.hasExited) throw startFailed(true);
        const ready = await health(url, authorization);
        if (ready.healthy) {
          version = ready.version;
          break;
        }
        if (Date.now() >= deadline) throw startFailed();
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
      proc,
    };
    this.server = server;
    this.options.record?.("start", "applied");
    void proc.exited.then(() => {
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
    if (!this.server?.proc) this.hook(false);
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
