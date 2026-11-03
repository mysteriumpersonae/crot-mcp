/**
 * Owner-configured AI provider runtime.
 *
 * All outbound HTTP calls to AI providers (models, generate, workspace) use Node native
 * fetch() directly — bypassing ExecutionGuard — because chat-runtime is owner/control-plane
 * code, not a sandboxed project agent. ExecutionGuard still governs tool invocations that
 * the AI triggers (invokeTool below). An explicit runtime deny rule for network.request is
 * respected by checking permissions.runtime before each fetch.
 */
import { workspaceInventory, workspaceReply } from "./workspace-chat.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newSession, type AuthContext } from "../core/auth/principal.js";
import type { CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import { TOOLS } from "../adapters/mcp/tools.js";
import { invokeTool } from "../adapters/mcp/invoke.js";
import { ChatEventStream } from "./chat-stream.js";
/**
 * Check whether the runtime has explicitly denied network.request for this core.
 * Returns true if the request must be blocked; false if it may proceed via native fetch().
 */
function isNetworkDenied(core: CrotCore): boolean {
  if (core.permissions.runtime.halted) return true;
  const rules = core.permissions.runtime.policy.rules;
  return rules.some(
    (r) => r.state === "deny" && (r.operation === "network.request" || r.capability === "network.access"),
  );
}

/**
 * Control-plane HTTP fetch: no ExecutionGuard, no NetworkPolicy check.
 * Callers MUST call isNetworkDenied() first.
 */
async function controlFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ status: number; body: string }> {
  const signal =
    options.signal && options.timeoutMs
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
      : (options.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined));
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
    signal,
  });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Streaming fetch for SSE chat completions.
 * onChunk receives each raw Buffer chunk from the response body.
 */
async function controlFetchStream(
  url: string,
  options: {
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  onChunk: (chunk: Buffer) => void,
  onStart?: (status: number, contentType: string) => void,
): Promise<{ status: number; contentType: string }> {
  const signal =
    options.signal && options.timeoutMs
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
      : (options.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined));
  const res = await fetch(url, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    signal,
  });
  const contentType = res.headers.get("content-type") ?? "";
  onStart?.(res.status, contentType);
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(Buffer.from(value));
    }
  }
  return { status: res.status, contentType };
}

import {
  baseProvider,
  ChatStartSchema,
  isCustomFamily,
  isProfileKey,
  type ChatBaseProvider,
  type ChatMessage,
  type ChatProvider,
  type ChatStart,
} from "./chat-protocol.js";
import { projectPrompt, projectToolDefinitions, type ChatProject } from "./chat-project-tools.js";

export interface ProviderDiagnostic {
  code: string;
  stage: string;
  httpStatus?: number;
  networkCode?: string;
}

/**
 * Diagnostic codes for UI display:
 * NETWORK_GUARD_BLOCKED – CROT network policy blocked the request (add host to permissions.network.allow)
 * AUTH_INVALID_KEY      – server rejected the credential (HTTP 401/403)
 * LOCAL_SERVER_OFFLINE  – local service not running (ECONNREFUSED on loopback)
 * OPERATION_FAILED      – other network or protocol error
 */
/** Never expose provider bodies, arbitrary thrown messages, URLs or credentials as diagnostics. */
export function providerDiagnostic(error: unknown): ProviderDiagnostic {
  if (!(error instanceof CrotError)) return { code: "OPERATION_FAILED", stage: "network" };
  const d = error.details,
    status = Number(d?.httpStatus),
    errno = String(d?.errno ?? "");
  // PERMISSION_DENIED from the ExecutionGuard (network policy block or explicit deny rule):
  // - network policy block: details.missing is [] (empty array, explicitly set)
  // - explicit runtime deny: details.missing is [] as well, but both map to NETWORK_GUARD_BLOCKED
  //   because from the UI perspective the owner blocked network access.
  // - bare PERMISSION_DENIED with no details (e.g. other service denials) → pass through as-is.
  if (error.code === "PERMISSION_DENIED") {
    if (Array.isArray(d?.missing)) return { code: "NETWORK_GUARD_BLOCKED", stage: "network" };
    return { code: "PERMISSION_DENIED", stage: "network" };
  }
  // ECONNREFUSED on a loopback address → local server not running.
  if (errno === "ECONNREFUSED") {
    return { code: "LOCAL_SERVER_OFFLINE", stage: "network", networkCode: errno };
  }
  // HTTP 401 or 403 → invalid key/credential.
  if (Number.isInteger(status) && (status === 401 || status === 403)) {
    return {
      code: "AUTH_INVALID_KEY",
      stage: ["models", "workspace", "inventory"].includes(String(d?.stage)) ? String(d?.stage) : "network",
      httpStatus: status,
    };
  }
  return {
    code: error.code,
    stage: ["models", "workspace", "inventory"].includes(String(d?.stage)) ? String(d?.stage) : "network",
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...([
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ETIMEDOUT",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(errno)
      ? { networkCode: errno }
      : {}),
  };
}

export interface ChatProviderConfig {
  endpoint: string;
  defaultModel?: string;
  username?: string;
  /** "anthropic" for Anthropic-protocol servers; defaults to "openai" */
  protocol?: "openai" | "anthropic";
  connectionError?: ProviderDiagnostic;
  checkedAt?: string;
  connectionStatus?: "connected" | "failed";
  /** Display name of a custom profile ("River"); derived from the endpoint host when absent. */
  label?: string;
}

/** Free models available on OpenCode (Free & Zen) without an API key. */
export const OPENCODE_FREE_MODELS: readonly string[] = [
  "big-pickle",
  "glm-4.7-free",
  "minimax-m2.1-free",
  "grok-code",
  "deepseek-r1-free",
  "meta-llama/llama-4-scout",
];

export const CHAT_ENDPOINTS: Record<ChatBaseProvider, string> = {
  OpenAI: "https://api.openai.com/v1",
  Anthropic: "https://api.anthropic.com/v1",
  "Google Gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  OpenRouter: "https://openrouter.ai/api/v1",
  "OpenCode (Free & Zen)": "https://opencode.ai/zen/v1",
  "Custom API": "",
  "OpenAI-compatible": "",
  "Local HTTP": "http://127.0.0.1:1234/v1",
  OpenCode: "http://127.0.0.1:4096",
  "Notion Agents": "https://api.notion.com/v1",
};

/**
 * Hosts that CROT adds to the live network.allow list when an owner saves a
 * provider (chat.configure) or when saved providers are restored
 * (ProductRuntime.open). Provider HTTP calls themselves use control-plane
 * fetch(), but the allow entries keep provider hosts reachable for any
 * guard-checked path, so the default `permissions.network.allow: []` never
 * yields NETWORK_GUARD_BLOCKED for an owner-configured provider.
 */
export const PROVIDER_NETWORK_HOSTS: Partial<Record<ChatBaseProvider, readonly string[]>> = {
  OpenAI: ["api.openai.com"],
  Anthropic: ["api.anthropic.com"],
  "Google Gemini": ["generativelanguage.googleapis.com"],
  OpenRouter: ["openrouter.ai"],
  "OpenCode (Free & Zen)": ["opencode.ai"],
  "Notion Agents": ["api.notion.com"],
  // LM Studio (1234) and Ollama (11434) defaults.
  "Local HTTP": ["127.0.0.1:1234", "localhost:1234", "127.0.0.1:11434", "localhost:11434"],
  OpenCode: ["127.0.0.1:4096", "localhost:4096"],
};

/**
 * Network allow entries for one configured provider: its static preset hosts
 * plus the host of its endpoint (custom or preset). Uses URL.host so that a
 * non-default port (e.g. 127.0.0.1:11434, api.example.com:8443) is kept —
 * a portless allow rule covers only ports 80 and 443.
 */
export function providerNetworkHosts(provider: ChatProvider, endpoint?: string): string[] {
  const base = baseProvider(provider);
  const hosts = new Set<string>(PROVIDER_NETWORK_HOSTS[base] ?? []);
  const url = endpoint || CHAT_ENDPOINTS[base];
  if (url)
    try {
      const host = new URL(url).host.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // Malformed endpoints are rejected by chatEndpoint(); nothing to allow.
    }
  return [...hosts];
}

/** Providers that work without a stored credential. */
export const credentialRequired = (provider: ChatProvider): boolean =>
  !["Local HTTP", "OpenCode", "OpenCode (Free & Zen)"].includes(baseProvider(provider));
const isWorkspaceProvider = (provider: ChatProvider): provider is "OpenCode" | "Notion Agents" =>
  provider === "OpenCode" || provider === "Notion Agents";
const literalHost = (host: string): boolean => host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[");

/**
 * Profile slug of a custom server, from its endpoint host: "https://api.river.ai/v1" → "river",
 * "http://127.0.0.1:8080/v1" → "127-0-0-1-8080". Lowercase letters, digits and dashes only.
 */
export function customSlug(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "custom";
  }
  const host = url.hostname.toLowerCase();
  const name = literalHost(host) ? host : (host.replace(/^(?:api|www)\./, "").split(".")[0] ?? "");
  const slug = `${name}${url.port ? `-${url.port}` : ""}`
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || "custom";
}

/** Display name of a custom server: "https://api.river.ai/v1" → "River", loopback/IP → "host:port". */
export function customLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint),
      host = url.hostname.toLowerCase();
    if (literalHost(host)) return url.host;
    const name = host.replace(/^(?:api|www)\./, "").split(".")[0] || host;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "Custom";
  }
}

interface Host {
  core(): CrotCore;
  configuration(provider: ChatProvider): ChatProviderConfig | undefined;
  credential(provider: ChatProvider): string | undefined;
  context(): AuthContext;
  run(context: AuthContext, work: (context: AuthContext) => Promise<void>): Promise<unknown>;
  /** The open project: the chat then gets its context and the read-only project tools. */
  project?(): ChatProject | undefined;
  /** Saved provider keys, including custom profiles ("Custom API:river"). */
  configured?(): readonly ChatProvider[];
}

interface Block {
  type: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  status?: string;
}
interface Conversation {
  id: string;
  provider: ChatProvider;
  model: string;
  /** The thread this turn belongs to and the earlier turns sent as history. */
  thread: string;
  history: ChatMessage[];
  /** The owner's turn as remembered in the thread (message and text attachments). */
  prompt: string;
  state: "running" | "completed" | "cancelled" | "failed";
  blocks: Block[];
  error?: string;
  controller: AbortController;
  done?: Promise<void>;
}
interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
/** A conversation thread: completed turns, resent to the provider with each new message. */
interface Thread {
  id: string;
  messages: ChatMessage[];
}
const MAX_THREADS = 16;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 120_000;
const MAX_REMEMBERED_CHARS = 48_000;
/** Tool output sent back to the model, and the share of it shown in the transcript. */
const MAX_TOOL_OUTPUT = 48_000;
const MAX_TOOL_DISPLAY = 2_000;
/** Default read size of fs_read_file in the chat, so a large file arrives in parts instead of failing. */
const CHAT_READ_LENGTH = 20_000;
const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
const parseArguments = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const bad = (message: string): never => {
  throw new CrotError("OPERATION_FAILED", message);
};
export function chatEndpoint(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new CrotError("INVALID_INPUT", "Choose an HTTP(S) API base without credentials, query or fragment");
  return url.href.replace(/\/+$/, "");
}
export class ChatRuntime {
  private readonly conversations = new Map<string, Conversation>();
  private readonly threads = new Map<string, Thread>();
  private lastThread: string | undefined;
  private closed = false;
  constructor(private readonly host: Host) {}
  get running(): boolean {
    return [...this.conversations.values()].some((c) => c.state === "running");
  }
  /** The latest turn, unless its thread was reset ("New chat") and it is no longer running. */
  get current(): string | undefined {
    const last = [...this.conversations.values()].at(-1);
    return last && (last.state === "running" || last.thread === this.currentThread) ? last.id : undefined;
  }
  /** The thread of the latest turn, while the service still remembers it. */
  get currentThread(): string | undefined {
    return this.lastThread && this.threads.has(this.lastThread) ? this.lastThread : undefined;
  }
  providers(): Record<string, unknown>[] {
    const keys: ChatProvider[] = Object.keys(CHAT_ENDPOINTS) as ChatBaseProvider[];
    for (const key of this.host.configured?.() ?? []) if (isProfileKey(key) && !keys.includes(key)) keys.push(key);
    return keys.map((provider) => {
      const base = baseProvider(provider),
        config = this.host.configuration(provider),
        required = credentialRequired(provider),
        credentialStored = !!this.host.credential(provider);
      // A provider that needs a credential but has none stored is not connected, whatever an older check
      // recorded: no stale "connected" badge and no leftover error for a removed key.
      const status = required && !credentialStored ? undefined : config?.connectionStatus;
      return {
        provider,
        base,
        ...(isCustomFamily(provider)
          ? { displayName: config?.label || (config?.endpoint ? customLabel(config.endpoint) : base) }
          : {}),
        endpoint: config?.endpoint ?? CHAT_ENDPOINTS[base],
        defaultModel: config?.defaultModel,
        username: config?.username,
        protocol: config?.protocol ?? "openai",
        credentialRequired: required,
        kind: isWorkspaceProvider(provider) ? "workspace" : "model",
        // A verified connection never carries a stale diagnostic (e.g. an old NETWORK_GUARD_BLOCKED).
        connectionError: status === "failed" ? config?.connectionError : undefined,
        checkedAt: status ? config?.checkedAt : undefined,
        connectionStatus: status,
        configured: !!config,
        credentialStored,
      };
    });
  }
  private settings(provider: ChatProvider): { endpoint: string; headers: Record<string, string>; anthropic: boolean } {
    const config = this.host.configuration(provider);
    if (!config) return bad("Configure the chat provider first");
    const key = this.host.credential(provider),
      base = baseProvider(provider);
    // OpenCode Free & Zen: key is optional (free models need no key)
    if (credentialRequired(provider) && !key) return bad("Provider credential is not configured");
    // Anthropic, or a Custom API profile that speaks the Anthropic protocol.
    const anthropicProtocol = base === "Anthropic" || (base === "Custom API" && config.protocol === "anthropic");
    return {
      endpoint: chatEndpoint(config.endpoint),
      anthropic: anthropicProtocol,
      headers: {
        "content-type": "application/json",
        ...(provider === "OpenCode"
          ? key
            ? { authorization: `Basic ${Buffer.from(`${config.username || "opencode"}:${key}`).toString("base64")}` }
            : {}
          : provider === "Notion Agents"
            ? { "Notion-Version": "2026-03-11", authorization: `Bearer ${key}` }
            : anthropicProtocol
              ? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
              : key
                ? { authorization: `Bearer ${key}` }
                : {}),
      },
    };
  }
  async models(provider: ChatProvider): Promise<Record<string, unknown>> {
    const { endpoint, headers } = this.settings(provider),
      base = baseProvider(provider),
      models = new Set<string>();
    if (isWorkspaceProvider(provider))
      return workspaceInventory(provider, (route, method, body) =>
        this.workspaceRequest(provider, this.host.context(), route, method, body),
      );
    if (isNetworkDenied(this.host.core()))
      throw new CrotError("PERMISSION_DENIED", "Runtime policy denies network.request", {
        operation: "network.request",
        missing: [],
      });
    // OpenCode (Free & Zen): try /models but fall back to bundled free model list on failure
    if (provider === "OpenCode (Free & Zen)") {
      try {
        const r = await controlFetch(`${endpoint}/models`, {
          headers,
          timeoutMs: 10000,
          signal: this.host.context().signal,
        });
        if (r.status === 200) {
          let body: Record<string, unknown>;
          try {
            body = record(JSON.parse(r.body));
          } catch {
            body = {};
          }
          if (Array.isArray(body.data)) {
            const fetched: string[] = [];
            for (const item of array(body.data)) {
              const id = text(record(item).id);
              if (id && id.length <= 256) fetched.push(id);
            }
            if (fetched.length > 0)
              return {
                ok: true,
                models: fetched.sort(),
                labels: {
                  "big-pickle": "Big Pickle (free)",
                  "glm-4.7-free": "GLM-4.7 (free)",
                  "minimax-m2.1-free": "MiniMax M2.1 (free)",
                },
              };
          }
        }
      } catch {
        /* fall through to bundled list */
      }
      return {
        ok: true,
        models: [...OPENCODE_FREE_MODELS].sort(),
        labels: Object.fromEntries(OPENCODE_FREE_MODELS.map((m) => [m, `${m} (free)`])),
      };
    }
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const response = await controlFetch(
        `${endpoint}/models${base === "Anthropic" ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}` : ""}`,
        { headers, timeoutMs: 30000, signal: this.host.context().signal },
      );
      // 404 or non-200 on /models is common for custom servers — treat as empty (user enters model manually).
      if (response.status === 404 || (base === "Custom API" && response.status !== 200))
        return { ok: true, models: [] };
      if (response.status !== 200)
        throw new CrotError("OPERATION_FAILED", "Model inventory request failed", {
          stage: "models",
          httpStatus: response.status,
        });
      let body: Record<string, unknown>;
      try {
        body = record(JSON.parse(response.body));
      } catch {
        return bad("Invalid provider model inventory");
      }
      if (!Array.isArray(body.data))
        throw new CrotError("OPERATION_FAILED", "Provider returned no valid model inventory", { stage: "inventory" });
      for (const item of array(body.data)) {
        const id = text(record(item).id);
        if (id && id.length <= 256) models.add(id);
      }
      if (base !== "Anthropic" || body.has_more !== true) return { ok: true, models: [...models].sort() };
      const next = text(body.last_id);
      if (!next || next === cursor) return bad("Invalid provider model pagination");
      cursor = next;
    }
    return bad("Provider model pagination exceeds its limit");
  }
  private async workspaceRequest(
    provider: ChatProvider,
    context: AuthContext,
    route: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    if (isNetworkDenied(this.host.core()))
      throw new CrotError("PERMISSION_DENIED", "Runtime policy denies network.request", {
        operation: "network.request",
        missing: [],
      });
    const { endpoint, headers } = this.settings(provider);
    const response = await controlFetch(endpoint + route, {
      method,
      headers,
      timeoutMs: route.endsWith("/message") ? 120000 : 30000,
      signal: context.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status < 200 || response.status >= 300)
      throw new CrotError("OPERATION_FAILED", "Workspace agent request failed", {
        stage: "workspace",
        httpStatus: response.status,
      });
    try {
      return record(JSON.parse(response.body));
    } catch {
      return bad("Invalid workspace agent response");
    }
  }
  start(input: unknown): Record<string, unknown> {
    if (this.closed || this.host.core().permissions.runtime.halted) return bad("Chat is stopped");
    const p = ChatStartSchema.parse(input);
    for (const a of p.attachments) {
      const bytes = Buffer.from(a.data, "base64");
      if (a.mime === "text/plain") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      else if (
        (a.mime === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
        (a.mime === "image/jpeg" && !bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
        (a.mime === "image/webp" &&
          (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP"))
      )
        throw new CrotError("INVALID_INPUT", "Attachment content does not match its image type");
    }
    if (isWorkspaceProvider(p.provider) && (p.tools.length || p.attachments.some((a) => a.mime !== "text/plain")))
      return bad(
        "Workspace agents accept text only; CROT tool grants are not forwarded. Use the workspace agent permissions.",
      );
    this.settings(p.provider);
    if (new Set(p.tools).size !== p.tools.length || p.tools.some((name) => !TOOLS.some((t) => t.name === name)))
      return bad("Unknown or duplicate tool selection");
    if ([...this.conversations.values()].some((c) => c.state === "running"))
      return bad("Stop the active generation first");
    while (this.conversations.size >= 8) this.conversations.delete(this.conversations.keys().next().value!);
    const { thread, reset } = this.thread(p.thread);
    const c: Conversation = {
      id: randomUUID(),
      provider: p.provider,
      model: p.model,
      thread: thread.id,
      history: thread.messages.map((m) => ({ ...m })),
      prompt:
        p.message +
        p.attachments
          .map((a) =>
            a.mime === "text/plain"
              ? `\n[${a.name}]\n${Buffer.from(a.data, "base64").toString("utf8")}`
              : `\n[image: ${a.name}]`,
          )
          .join(""),
      state: "running",
      controller: new AbortController(),
      blocks: [
        {
          type: "user",
          text: p.message + (p.attachments.length ? `\n[${p.attachments.map((a) => a.name).join(", ")}]` : ""),
        },
      ],
    };
    this.conversations.set(c.id, c);
    const base = this.host.context(),
      session = newSession();
    const context: AuthContext = {
      ...base,
      principal: { id: `chat:${c.id}`, kind: "local", transport: "owner-chat", client: { name: `${p.provider} chat` } },
      session,
      exposureScope: session,
      signal: c.controller.signal,
    };
    c.done = this.host
      .run(context, async (ctx) => {
        try {
          await this.generate(c, p, ctx);
        } catch {
          return bad("Chat generation failed");
        }
      })
      .then(
        () => {
          c.state = c.controller.signal.aborted ? "cancelled" : "completed";
          this.remember(c);
        },
        () => {
          c.state = c.controller.signal.aborted ? "cancelled" : "failed";
          for (const block of c.blocks) if (block.type === "tool" && block.status === "running") block.status = c.state;
          // No provider response, key, prompt or thrown decoder text is reflected as an error.
          c.error =
            c.state === "failed"
              ? "Generation failed. Check provider configuration, model, Core policy and audit."
              : undefined;
          // A stopped answer stays part of the thread; a failed turn is not remembered (the owner retries).
          if (c.state === "cancelled") this.remember(c);
        },
      );
    return { ok: true, id: c.id, thread: thread.id, ...(reset ? { threadReset: true } : {}) };
  }
  /**
   * The thread a new turn continues. An unknown id (e.g. after a service restart) starts a new
   * thread and is reported as reset. Threads are kept in memory only, most recent last.
   */
  private thread(id: string | undefined): { thread: Thread; reset: boolean } {
    const known = id ? this.threads.get(id) : undefined;
    const thread = known ?? { id: randomUUID(), messages: [] };
    this.threads.delete(thread.id);
    this.threads.set(thread.id, thread);
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!);
    this.lastThread = thread.id;
    return { thread, reset: !!id && !known };
  }
  /** Add a finished turn to its thread; the oldest turns go first when the history exceeds its bounds. */
  private remember(c: Conversation): void {
    const thread = this.threads.get(c.thread);
    const reply = c.blocks
      .filter((b) => b.type === "assistant" && b.text.trim())
      .map((b) => b.text.trim())
      .join("\n\n");
    if (!thread || !reply) return;
    thread.messages.push(
      { role: "user", content: clip(c.prompt, MAX_REMEMBERED_CHARS) },
      { role: "assistant", content: clip(reply, MAX_REMEMBERED_CHARS) },
    );
    const size = () => thread.messages.reduce((n, m) => n + m.content.length, 0);
    while (thread.messages.length > MAX_HISTORY_MESSAGES || (thread.messages.length > 2 && size() > MAX_HISTORY_CHARS))
      thread.messages.splice(0, 2);
  }
  /** Forget a thread (default: the latest); the next turn starts without history. */
  reset(id?: string): Record<string, unknown> {
    const target = id ?? this.lastThread;
    if (!target) return { ok: true };
    this.threads.delete(target);
    if (target === this.lastThread) this.lastThread = undefined;
    for (const [key, c] of this.conversations)
      if (c.thread === target && c.state !== "running") this.conversations.delete(key);
    return { ok: true };
  }
  poll(id: string): Record<string, unknown> {
    const c = this.conversations.get(id);
    if (!c) return bad("Unknown conversation");
    return {
      ok: true,
      id,
      provider: c.provider,
      model: c.model,
      state: c.state,
      blocks: structuredClone(c.blocks),
      ...(c.error ? { error: c.error } : {}),
    };
  }
  stop(id: string): Record<string, unknown> {
    const c = this.conversations.get(id);
    if (!c) return bad("Unknown conversation");
    c.controller.abort();
    return { ok: true };
  }
  private bounded(c: Conversation): void {
    if (Buffer.byteLength(JSON.stringify(c.blocks)) > 192000) {
      for (const block of c.blocks) block.text = block.text.slice(0, 2048);
      throw new CrotError("LIMIT_EXCEEDED", "Conversation exceeds its display limit");
    }
  }
  private async generate(c: Conversation, p: ChatStart, context: AuthContext): Promise<void> {
    if (isWorkspaceProvider(p.provider)) {
      const provider = p.provider;
      // Workspace agents start a new session per message, so earlier turns travel in the message itself.
      const transcript = c.history
        .map((m) => `${m.role === "user" ? "Owner" : "Assistant"}: ${m.content}`)
        .join("\n\n")
        .slice(-24000);
      const message =
        (transcript ? `Conversation so far:\n${transcript}\n\nNew message:\n` : "") +
        p.message +
        p.attachments.map((a) => `\n[${a.name}]\n${Buffer.from(a.data, "base64").toString("utf8")}`).join("");
      const reply = await workspaceReply(
        provider,
        p.model,
        message,
        context.signal,
        (route, method, body) => this.workspaceRequest(provider, context, route, method, body),
        (route) =>
          this.workspaceRequest(
            provider,
            { ...this.host.context(), signal: AbortSignal.timeout(3000) },
            route,
            "POST",
            {},
          ),
      );
      c.blocks.push({ type: "assistant", text: reply });
      this.bounded(c);
      return;
    }
    const { endpoint, headers, anthropic } = this.settings(p.provider);
    const content: unknown[] = [{ type: "text", text: p.message }];
    for (const a of p.attachments) {
      const bytes = Buffer.from(a.data, "base64");
      if (a.mime === "text/plain") content.push({ type: "text", text: `[${a.name}]\n${bytes.toString("utf8")}` });
      else if (anthropic) content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.data } });
      else content.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data}` } });
    }
    const project = this.host.project?.();
    // The open project's read-only tools are on by default; the owner's tool selection adds to them.
    const automatic =
      project && p.projectTools ? projectToolDefinitions().filter((t) => !p.tools.includes(t.name)) : [];
    let definitions = [...TOOLS.filter((t) => p.tools.includes(t.name)), ...automatic];
    const encode = () =>
      definitions.map((t) => {
        const schema = z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" });
        return anthropic
          ? { name: t.name, description: t.description, input_schema: schema }
          : { type: "function", function: { name: t.name, description: t.description, parameters: schema } };
      });
    let tools = encode();
    const prompt = async () =>
      project
        ? await projectPrompt(
            this.host.core(),
            context,
            project,
            definitions.map((d) => d.name),
          )
        : undefined;
    let system = await prompt();
    const history = c.history.map((m) => ({ role: m.role, content: m.content }));
    const messages: unknown[] = [...history, { role: "user", content }];
    // A server that rejects tool definitions (many local models) still gets the conversation once without them.
    let toolFallback = automatic.length > 0 && p.tools.length === 0;
    for (let round = 0; round < 8; round++) {
      if (context.signal?.aborted || this.closed) return bad("Generation cancelled");
      const assistant: Block = { type: "assistant", text: "" };
      c.blocks.push(assistant);
      const calls = new Map<number, ToolCall>();
      let completed = false;
      const stream = new ChatEventStream((event, data) => {
        if (context.signal?.aborted) return bad("Generation cancelled");
        if (completed) return bad("Provider sent data after completion");
        if (data === "[DONE]") {
          completed = true;
          return;
        }
        let value: Record<string, unknown>;
        try {
          value = record(JSON.parse(data));
        } catch {
          return bad("Invalid provider stream event");
        }
        if (event === "error" || value.error) return bad("Provider stream failed");
        if (anthropic) {
          if (event === "message_stop") completed = true;
          const delta = record(value.delta),
            block = record(value.content_block),
            index = Number(value.index);
          if (event === "content_block_start" && block.type === "text") assistant.text += text(block.text);
          if (event === "content_block_start" && block.type === "tool_use") {
            if (!Number.isInteger(index) || index < 0 || index >= 16 || calls.has(index))
              return bad("Invalid tool block index");
            calls.set(index, {
              id: text(block.id),
              name: text(block.name),
              arguments: Object.keys(record(block.input)).length ? JSON.stringify(block.input) : "",
            });
          }
          if (delta.type === "text_delta") assistant.text += text(delta.text);
          if (delta.type === "input_json_delta") {
            const call = calls.get(index);
            if (!call) return bad("Invalid streamed tool block");
            call.arguments += text(delta.partial_json);
          }
        } else {
          const choice = record(array(value.choices)[0]),
            delta = record(choice.delta);
          assistant.text += text(delta.content);
          for (const item of array(delta.tool_calls)) {
            const call = record(item),
              index = Number(call.index),
              fn = record(call.function);
            if (!Number.isInteger(index) || index < 0 || index >= 16) return bad("Invalid tool index");
            const entry = calls.get(index) ?? { id: "", name: "", arguments: "" };
            entry.id += text(call.id);
            entry.name += text(fn.name);
            entry.arguments += text(fn.arguments);
            calls.set(index, entry);
          }
        }
        if (
          calls.size > 16 ||
          [...calls.values()].some(
            (call) => call.arguments.length > 32000 || call.name.length > 128 || call.id.length > 256,
          )
        )
          return bad("Provider tool arguments exceed their limit");
        this.bounded(c);
      });
      if (isNetworkDenied(this.host.core())) return bad("Runtime policy denies network.request");
      let streamingOk = false;
      const { status: streamStatus } = await controlFetchStream(
        `${endpoint}/${anthropic ? "messages" : "chat/completions"}`,
        {
          headers,
          body: JSON.stringify({
            model: p.model,
            ...(anthropic && system ? { system } : {}),
            messages: !anthropic && system ? [{ role: "system", content: system }, ...messages] : messages,
            stream: true,
            ...(p.provider === "OpenAI" ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
            ...(tools.length ? { tools } : {}),
          }),
          signal: context.signal,
          timeoutMs: 120000,
        },
        (chunk) => {
          if (streamingOk) stream.push(chunk);
        },
        (status, ct) => {
          streamingOk = status >= 200 && status < 300 && ct.includes("text/event-stream");
        },
      );
      if (toolFallback && round === 0 && (streamStatus === 400 || streamStatus === 422)) {
        // Retry once without the automatic project tools; the prompt then says file tools are unavailable.
        toolFallback = false;
        definitions = [];
        tools = encode();
        system = await prompt();
        c.blocks.pop();
        continue;
      }
      toolFallback = false;
      if (!streamingOk || streamStatus < 200 || streamStatus >= 300)
        return bad(`Provider streaming failed (HTTP ${streamStatus})`);
      stream.end();
      if (!completed) return bad("Provider stream ended without completion");
      if (!calls.size) return;
      const ordered = [...calls.values()];
      const ids = new Set<string>();
      for (const call of ordered)
        if (!call.id || !call.name || ids.has(call.id)) return bad("Invalid provider tool call");
        else ids.add(call.id);
      messages.push(
        anthropic
          ? {
              role: "assistant",
              content: [
                ...(assistant.text ? [{ type: "text", text: assistant.text }] : []),
                ...ordered.map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: parseArguments(call.arguments) ?? {},
                })),
              ],
            }
          : {
              role: "assistant",
              content: assistant.text || null,
              tool_calls: ordered.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments || "{}" },
              })),
            },
      );
      const results: unknown[] = [];
      for (const call of ordered) {
        if (context.signal?.aborted || this.closed) return bad("Generation cancelled");
        const block: Block = {
          type: "tool",
          name: call.name,
          status: "running",
          text: clip(call.arguments, MAX_TOOL_DISPLAY),
        };
        c.blocks.push(block);
        this.bounded(c);
        const definition = definitions.find((d) => d.name === call.name);
        const args = parseArguments(call.arguments);
        // A large file arrives in parts: the model continues with offset (see the read result's 'truncated').
        if (args && call.name === "fs_read_file" && args.length === undefined) args.length = CHAT_READ_LENGTH;
        const result = !definition
          ? { isError: true, content: [{ type: "text", text: "Tool was not enabled by the user" }] }
          : !args
            ? { isError: true, content: [{ type: "text", text: "Tool arguments must be a JSON object" }] }
            : await invokeTool(this.host.core(), () => context, {
                definition,
                args,
                request: {},
                signal: context.signal,
              });
        if (context.signal?.aborted) return bad("Generation cancelled");
        const serialized = JSON.stringify(result);
        const tooLarge = serialized.length > MAX_TOOL_OUTPUT;
        const output = !tooLarge
          ? serialized
          : JSON.stringify({
              isError: true,
              message: `Tool result exceeded the chat transfer limit (${MAX_TOOL_OUTPUT} characters). Read files in parts with a smaller length and an offset, or list a narrower path with fewer maxEntries.`,
            });
        block.status = result.isError || tooLarge ? "failed" : "completed";
        block.text += `\n${clip(output, MAX_TOOL_DISPLAY)}`;
        this.bounded(c);
        if (anthropic)
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: output,
            is_error: !!result.isError || tooLarge,
          });
        else messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      if (anthropic) messages.push({ role: "user", content: results });
    }
    return bad("Chat tool round limit reached");
  }
  async cancelAll(): Promise<void> {
    for (const c of this.conversations.values()) c.controller.abort();
    await Promise.all([...this.conversations.values()].map((c) => c.done));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.cancelAll();
    this.threads.clear();
    this.lastThread = undefined;
  }
}
