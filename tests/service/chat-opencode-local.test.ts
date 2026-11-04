/**
 * Local OpenCode: CROT's own `opencode serve` (the bridge: random password, 127.0.0.1, stopped with CROT, an
 * owner's unprotected server reused), OpenCode Zen through it without a key, the owner's OpenCode key with
 * OpenCode's session headers, and "Start and connect OpenCode" in Workspaces. A fake OpenCode server (Node)
 * stands in for the real one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_VERSION } from "../../src/core/crot-core.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { basicAuthorization, OpenCodeBridge, type OpenCodeBridgeOptions } from "../../src/service/opencode-bridge.js";
import { ProductRuntime, type ProductHost } from "../../src/service/product-runtime.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { createTestCore, makeTempDirs, waitFor } from "../helpers.js";

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

/** The fake server started by hand: the owner's own `opencode serve`. */
const external: ChildProcess[] = [];
async function ownerServer(port: number, password?: string): Promise<void> {
  const child = spawn(process.execPath, [FAKE, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
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
        server: { url: server.url, managed: true, version: "0.0.0-fake" },
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
    } finally {
      await Promise.all([missing.close(), denied.close(), exits.close()]);
      await dirs.cleanup();
    }
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
  async function setup() {
    const dirs = await makeTempDirs();
    const zen = zenServer();
    await new Promise<void>((r) => zen.server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(zen.server.address() as net.AddressInfo).port}/zen/v1`;
    const stateDir = path.join(dirs.outside, "state");
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const core: CrotCore = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
    });
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
      },
      openCode: options,
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
    return { dirs, zen, endpoint, stateDir, options, audit, runtime, rpc, listed, chat, cleanup };
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
      });
      expect(await listed(ZEN)).toMatchObject({ connectionStatus: "connected", route: "local" });
      const status = await rpc("opencode.status");
      expect(status.server).toEqual({ url: `http://127.0.0.1:${options.port}`, managed: true, version: "0.0.0-fake" });
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

      // CROT tools and images need a Zen key.
      const tools = await chat(ZEN, "big-pickle", { tools: ["crot_status"] });
      expect(tools).toMatchObject({ state: "failed", error: expect.stringContaining("answers text only") });

      // OpenCode's free tier limit (OpenCode keeps retrying): stopped at once with a fixed message.
      await writeFile(options.mode, "limit");
      const limited = await chat(ZEN, "big-pickle");
      expect(limited).toMatchObject({ state: "failed", error: expect.stringContaining("free usage limit is reached") });
      expect(JSON.stringify(limited)).not.toContain("subscribe");
      const after = await readLog(options.log);
      expect(after.filter((l) => l.path === "/session/ses_3/abort")).toHaveLength(1);
      expect(after.filter((l) => l.method === "DELETE" && l.path === "/session/ses_3")).toHaveLength(1);
      const refused = await rpc("chat.testConnection", { provider: ZEN });
      expect(refused).toMatchObject({
        ok: false,
        diagnostic: { code: "FREE_TIER_LIMIT", httpStatus: 429 },
        openCode: { installed: true, server: { managed: true } },
      });
      expect(await listed(ZEN)).toMatchObject({
        connectionStatus: "failed",
        connectionError: { code: "FREE_TIER_LIMIT" },
      });
      await writeFile(options.mode, "ok");

      // Disconnecting stops CROT's server; connecting again starts a new one, and closing CROT stops it.
      await rpc("chat.remove", { provider: ZEN });
      expect((await rpc("opencode.status")).server).toBeUndefined();
      expect(await healthStatus(`http://127.0.0.1:${options.port}`)).toBe("down");
      await rpc("chat.configure", { provider: ZEN, endpoint: t.endpoint });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({ ok: true, route: "local" });
      await t.runtime.close();
      expect(await healthStatus(`http://127.0.0.1:${options.port}`)).toBe("down");
      expect(t.audit).toEqual(["start:applied", "stop:applied", "start:applied", "stop:applied"]);
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
      const other = await chat(ZEN, "big-pickle");
      expect(other.state).toBe("completed");
      const requests = t.zen.seen.filter((s) => s.url === "/zen/v1/chat/completions");
      expect(requests).toHaveLength(3);
      for (const r of [...requests, t.zen.seen[0]!]) {
        expect(r.headers.authorization).toBe(`Bearer ${key}`);
        expect(r.headers["user-agent"]).toBe(`CROT/${CORE_VERSION}`);
        expect(r.headers["x-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.headers["x-opencode-session"]).toBe(r.headers["x-session-id"]);
      }
      // One session per thread.
      expect(requests[1]!.headers["x-session-id"]).toBe(requests[0]!.headers["x-session-id"]);
      expect(requests[2]!.headers["x-session-id"]).not.toBe(requests[0]!.headers["x-session-id"]);
      // No local server for a keyed Zen; the key is never shown.
      expect((await rpc("opencode.status")).server).toBeUndefined();
      const shown = JSON.stringify([checked, await rpc("chat.providers"), await rpc("opencode.status"), first, second]);
      expect(shown).not.toContain(key);
      expect(await readFile(path.join(t.stateDir, "product-state.json"), "utf8").catch(() => "")).not.toContain(key);
      // Another host in the endpoint field never gets the owner's key.
      await rpc("chat.configure", { provider: ZEN, endpoint: "https://zen.example.test/zen/v1" });
      const elsewhere = await rpc("chat.models", { provider: ZEN });
      expect(elsewhere).toMatchObject({ ok: true, route: "local", idle: true });
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

  it("Start and connect OpenCode (Workspaces) runs CROT's own server and stops it on request", async () => {
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
});
