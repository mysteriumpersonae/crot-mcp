/**
 * OpenCode (Free & Zen): the bundled catalog (the free models of OpenCode 1.19.5), never anonymous use of Zen
 * (without a key and without local OpenCode the owner is told to install OpenCode), the live inventory with a
 * key, Anthropic-protocol models, fixed owner-facing failures with OpenCode's own detail, and disconnecting.
 */
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CrotError } from "../../src/core/errors.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import {
  chatFailure,
  chatFailureDetail,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_FREE_MODELS,
  OPENCODE_MODEL_LABELS,
  providerDiagnostic,
  zenInventory,
} from "../../src/service/chat-runtime.js";
import { ProductRuntime } from "../../src/service/product-runtime.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { createTestCore, makeTempDirs, waitFor } from "../helpers.js";

const ZEN = "OpenCode (Free & Zen)";
const model = (id: string, api: string, input: number, output: number, name: string) => ({
  id,
  object: "model",
  name,
  cost: { text: { input: { price: input, cache: { read: 0, write: 0 } }, output: { price: output } } },
  api: { [api]: { base_url: "https://opencode.ai/inference/v1" } },
});
const INVENTORY = {
  object: "list",
  data: [
    model("big-pickle", "chat-completions", 0, 0, "Big Pickle"),
    model("kimi-k2.6", "chat-completions", 0.95, 4, "Kimi K2.6"),
    model("claude-haiku-4-5", "messages", 1, 5, "Claude Haiku 4.5"),
    model("gpt-5.4", "responses", 2.5, 15, "GPT-5.4"),
    model("gemini-3.5-flash", "generate-content", 1.5, 9, "Gemini 3.5 Flash"),
    model("glm-5.3-flash-free", "chat-completions", 0, 0, "GLM-5.3-Flash Free"),
    model("qwen3.6-plus", "messages", 0.5, 3, "Qwen3.6 Plus"),
  ],
};

describe("zenInventory", () => {
  it("keeps chat-completions and messages models, Big Pickle and the free ones first, with labels", () => {
    expect(zenInventory(INVENTORY)).toEqual([
      { id: "big-pickle", label: "Big Pickle (free)", free: true, protocol: "openai" },
      { id: "glm-5.3-flash-free", label: "GLM-5.3-Flash (free)", free: true, protocol: "openai" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Zen / Go)", free: false, protocol: "anthropic" },
      { id: "kimi-k2.6", label: "Kimi K2.6 (Zen / Go)", free: false, protocol: "openai" },
      { id: "qwen3.6-plus", label: "Qwen3.6 Plus (Zen / Go)", free: false, protocol: "anthropic" },
    ]);
    // Older inventories without api/cost: chat completions, free by the "-free" suffix; junk is skipped.
    expect(
      zenInventory({
        data: [
          null,
          { id: 5 },
          { id: "legacy-free" },
          { id: "legacy" },
          { id: "legacy" },
          { id: "x".repeat(257) },
          {
            id: "ctl",
            name: "Bad\u0007 Name",
          },
        ],
      }),
    ).toEqual([
      { id: "legacy-free", label: "legacy-free (free)", free: true, protocol: "openai" },
      { id: "ctl", label: "Bad Name (Zen / Go)", free: false, protocol: "openai" },
      { id: "legacy", label: "legacy (Zen / Go)", free: false, protocol: "openai" },
    ]);
    expect(zenInventory(undefined)).toEqual([]);
    // The bundled catalog: exactly the free models OpenCode 1.19.5 lists without a key, its default first.
    expect(OPENCODE_DEFAULT_MODEL).toBe("big-pickle");
    expect(OPENCODE_FREE_MODELS).toEqual([
      "big-pickle",
      "beam-free",
      "crouton-alpha-free",
      "deepseek-v4.1-flash-free",
      "flint-40b-free",
      "glm-5.3-flash-free",
      "mimo-v2.6-flash-free",
      "nemotron-3.5-lightning-free",
      "nemotron-3.5-super-vl-free",
      "pulse-alpha-free",
    ]);
    expect(OPENCODE_FREE_MODELS.every((id) => OPENCODE_MODEL_LABELS[id]?.endsWith("(free)"))).toBe(true);
    expect(Object.keys(OPENCODE_MODEL_LABELS)).toEqual([...OPENCODE_FREE_MODELS]);
  });

  it("maps provider failures to fixed messages and diagnostics, never provider text", () => {
    const limit = new CrotError("OPERATION_FAILED", "Provider request failed", {
      stage: "probe",
      httpStatus: 429,
      reason: "free_usage_limit",
    });
    expect(providerDiagnostic(limit)).toEqual({ code: "FREE_USAGE_LIMIT", stage: "probe", httpStatus: 429 });
    expect(chatFailure(limit)).toContain("free usage limit");
    const status = (httpStatus: number) => chatFailure(new CrotError("OPERATION_FAILED", "x", { httpStatus }));
    expect(status(401)).toContain("HTTP 401");
    expect(status(403)).toContain("HTTP 403");
    expect(status(404)).toContain("HTTP 404");
    expect(status(429)).toContain("HTTP 429");
    expect(status(422)).toContain("HTTP 400/422");
    expect(status(503)).toContain("HTTP 5xx");
    expect(status(302)).toBeUndefined();
    expect(chatFailure(new CrotError("PERMISSION_DENIED", "x"))).toBe(
      "Network access is blocked by the runtime policy.",
    );
    expect(chatFailure(new Error("provider said secret"))).toBeUndefined();
    // The local OpenCode bridge.
    const local = (code: "OPERATION_FAILED" | "NOT_FOUND" | "PERMISSION_DENIED", reason: string, httpStatus?: number) =>
      new CrotError(code, "x", { stage: "local", reason, ...(httpStatus ? { httpStatus } : {}) });
    expect(providerDiagnostic(local("OPERATION_FAILED", "free_tier_limit", 429))).toEqual({
      code: "FREE_TIER_LIMIT",
      stage: "local",
      httpStatus: 429,
    });
    expect(providerDiagnostic(local("NOT_FOUND", "opencode_not_installed"))).toEqual({
      code: "OPENCODE_NOT_INSTALLED",
      stage: "local",
    });
    expect(providerDiagnostic(local("OPERATION_FAILED", "opencode_start_failed"))).toEqual({
      code: "OPENCODE_START_FAILED",
      stage: "local",
    });
    expect(providerDiagnostic(local("PERMISSION_DENIED", "opencode_refused"))).toEqual({
      code: "OPENCODE_START_REFUSED",
      stage: "local",
    });
    expect(chatFailure(local("OPERATION_FAILED", "free_tier_limit", 429))).toContain("free usage limit is reached");
    expect(chatFailure(local("NOT_FOUND", "opencode_not_installed"))).toBe(
      "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key.",
    );
    expect(chatFailure(local("OPERATION_FAILED", "opencode_start_failed"))).toContain("could not be started");
    expect(chatFailure(local("PERMISSION_DENIED", "opencode_refused"))).toContain("emergency stop");
    expect(chatFailure(local("OPERATION_FAILED", "local_text_only"))).toContain("text only");
    // OpenCode's own explanation: kept with the model and the exact status, for the owner only.
    const refused = new CrotError("OPERATION_FAILED", "x", {
      stage: "local",
      httpStatus: 500,
      model: "glm-5.3-flash-free",
      detail: "UnknownError: Unexpected server error. Check server logs for details. (ref err_1)",
    });
    expect(providerDiagnostic(refused)).toEqual({
      code: "OPERATION_FAILED",
      stage: "local",
      httpStatus: 500,
      model: "glm-5.3-flash-free",
      detail: "UnknownError: Unexpected server error. Check server logs for details. (ref err_1)",
    });
    expect(chatFailure(refused)).toBe("Local OpenCode refused the request.");
    expect(chatFailureDetail(refused)).toBe(
      "glm-5.3-flash-free · HTTP 500: UnknownError: Unexpected server error. Check server logs for details. (ref err_1)",
    );
    const tier = new CrotError("OPERATION_FAILED", "x", {
      stage: "local",
      httpStatus: 429,
      reason: "free_tier_limit",
      model: "big-pickle",
      detail: "Free usage exceeded, subscribe to Go (https://opencode.ai/go)",
    });
    expect(providerDiagnostic(tier)).toEqual({
      code: "FREE_TIER_LIMIT",
      stage: "local",
      httpStatus: 429,
      model: "big-pickle",
      detail: "Free usage exceeded, subscribe to Go (https://opencode.ai/go)",
    });
    // Without OpenCode's detail (every other provider) there is none, and nothing else is reflected.
    expect(chatFailureDetail(limit)).toBeUndefined();
    expect(chatFailureDetail(new Error("provider said secret"))).toBeUndefined();
    expect(providerDiagnostic(new CrotError("OPERATION_FAILED", "x", { httpStatus: 500, body: "secret" }))).toEqual({
      code: "OPERATION_FAILED",
      stage: "network",
      httpStatus: 500,
    });
  });
});

interface Seen {
  url: string;
  authorization?: string;
  apiKey?: string;
  version?: string;
  body?: Record<string, unknown>;
}

/** OpenCode Zen: /models, /chat/completions and /messages; `limit` refuses every completion (free usage limit). */
function zenServer() {
  const seen: Seen[] = [];
  const state = { limit: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      const url = req.url ?? "";
      seen.push({
        url,
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
        ...(typeof req.headers["anthropic-version"] === "string" ? { version: req.headers["anthropic-version"] } : {}),
        ...(body ? { body } : {}),
      });
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url === "/zen/v1/models") return json(200, INVENTORY);
      if (state.limit)
        return json(429, {
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage limit reached. provider-text-do-not-show" },
        });
      if (body?.stream === false) return json(200, { choices: [{ message: { content: "p" } }] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (data: unknown, event = "") =>
        res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
      if (url === "/zen/v1/messages") {
        send(
          { index: 0, delta: { type: "text_delta", text: `Answer from ${String(body?.model)}` } },
          "content_block_delta",
        );
        send({ type: "message_stop" }, "message_stop");
        res.end();
        return;
      }
      send({ choices: [{ delta: { content: `Answer from ${String(body?.model)}` } }] });
      res.end("data: [DONE]\n\n");
    });
  });
  return { seen, state, server };
}

describe("OpenCode (Free & Zen) connection and chat", () => {
  it("never uses Zen anonymously; with a key lists and chats with free and Zen models, then disconnects", async () => {
    const dirs = await makeTempDirs();
    const { seen, state, server } = zenServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}/zen/v1`;
    const stateDir = path.join(dirs.outside, "state");
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    const core: CrotCore = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: {
        mode: "full_control",
        network: { allow: [`127.0.0.1:${port}`] },
        approvals: { untrustedContent: "off" },
      },
    });
    const runtime = await ProductRuntime.open({
      stateDir,
      privateFiles,
      secrets: store,
      core: () => core,
      selectWorkspace: async () => {},
      recordControlEvent: async () => {},
    });
    const rpc = async (method: string, params: Record<string, unknown> = {}) =>
      (await runtime.request(method as never, params as never)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const listed = async () =>
      ((await rpc("chat.providers")).providers as Record<string, unknown>[]).find((p) => p.provider === ZEN)!;
    const chat = async (modelId: string) => {
      const started = await rpc("chat.start", { provider: ZEN, model: modelId, message: "hello", projectTools: false });
      await waitFor(async () => (await rpc("chat.poll", { id: started.id })).state !== "running");
      return rpc("chat.poll", { id: started.id });
    };
    const probes = () => seen.filter((s) => s.body?.max_tokens === 1);
    try {
      // Before any check: no key needed, the bundled free models are suggested.
      expect(await listed()).toMatchObject({
        credentialRequired: false,
        configured: false,
        suggestedModels: [...OPENCODE_FREE_MODELS],
        suggestedLabels: OPENCODE_MODEL_LABELS,
      });
      await rpc("chat.configure", { provider: ZEN, endpoint });

      // Save & Test without a key and without local OpenCode: the owner is told to install OpenCode or enter a
      // key; Zen is never asked anonymously.
      const missing = await rpc("chat.testConnection", { provider: ZEN });
      expect(missing).toMatchObject({ ok: false, diagnostic: { code: "OPENCODE_NOT_INSTALLED", stage: "local" } });
      expect(seen).toHaveLength(0);
      expect(await listed()).toMatchObject({
        connectionStatus: "failed",
        connectionError: { code: "OPENCODE_NOT_INSTALLED" },
      });
      // Listing the models shows the bundled catalog (OpenCode is missing) without asking anyone.
      expect(await rpc("chat.models", { provider: ZEN })).toEqual({
        ok: true,
        models: [...OPENCODE_FREE_MODELS],
        labels: { ...OPENCODE_MODEL_LABELS },
        free: [...OPENCODE_FREE_MODELS],
        route: "local",
        idle: true,
        installed: false,
      });
      const keyless = await chat("big-pickle");
      expect(keyless).toMatchObject({
        state: "failed",
        error:
          "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key.",
      });
      expect(keyless.errorDetail).toBeUndefined();
      expect(seen).toHaveLength(0);

      // With a Zen API key: Zen's live inventory (every supported model), no test request; Claude/Qwen over
      // /messages. Without a saved model the first free one (OpenCode's default, Big Pickle) is chosen.
      await rpc("chat.configure", { provider: ZEN, endpoint, credential: "zen-key" });
      const keyed = await rpc("chat.testConnection", { provider: ZEN });
      expect(keyed).toMatchObject({
        ok: true,
        models: ["big-pickle", "glm-5.3-flash-free", "claude-haiku-4-5", "kimi-k2.6", "qwen3.6-plus"],
        free: ["big-pickle", "glm-5.3-flash-free"],
        labels: { "big-pickle": "Big Pickle (free)", "glm-5.3-flash-free": "GLM-5.3-Flash (free)" },
        route: "zen",
        keySource: "stored",
        defaultModel: "big-pickle",
      });
      expect(keyed.modelCheck).toBeUndefined();
      expect(probes()).toHaveLength(0);
      expect(seen.map((s) => s.url)).toEqual(["/zen/v1/models"]);
      expect(seen[0]!.authorization).toBe("Bearer zen-key");
      expect(await listed()).toMatchObject({ connectionStatus: "connected", route: "zen", keySource: "stored" });
      expect((await listed()).connectionError).toBeUndefined();
      const answered = await chat("glm-5.3-flash-free");
      expect(answered.state).toBe("completed");
      expect(JSON.stringify(answered.blocks)).toContain("Answer from glm-5.3-flash-free");
      expect(seen.at(-1)).toMatchObject({ url: "/zen/v1/chat/completions", authorization: "Bearer zen-key" });
      // A saved model that the live inventory still has is kept.
      await rpc("chat.configure", { provider: ZEN, endpoint, defaultModel: "kimi-k2.6" });
      expect(await rpc("chat.testConnection", { provider: ZEN })).toMatchObject({
        ok: true,
        defaultModel: "kimi-k2.6",
      });

      // Zen's free usage limit during a chat: a fixed, actionable message, never Zen's own text.
      state.limit = true;
      const limited = await chat("big-pickle");
      expect(limited).toMatchObject({ state: "failed", error: expect.stringContaining("free usage limit") });
      expect(JSON.stringify(limited)).not.toContain("provider-text-do-not-show");
      state.limit = false;

      const claude = await chat("claude-haiku-4-5");
      expect(claude.state).toBe("completed");
      expect(JSON.stringify(claude.blocks)).toContain("Answer from claude-haiku-4-5");
      expect(seen.at(-1)).toMatchObject({ url: "/zen/v1/messages", apiKey: "zen-key", version: "2023-06-01" });
      expect(seen.at(-1)!.authorization).toBeUndefined();
      const kimi = await chat("kimi-k2.6");
      expect(kimi.state).toBe("completed");
      expect(seen.at(-1)).toMatchObject({ url: "/zen/v1/chat/completions", authorization: "Bearer zen-key" });

      // Disconnect: the provider and its key are gone.
      await rpc("chat.remove", { provider: ZEN });
      expect(await listed()).toMatchObject({ configured: false, credentialStored: false });
      expect((await listed()).connectionStatus).toBeUndefined();
    } finally {
      await runtime.close();
      await core.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await dirs.cleanup();
    }
  });
});
