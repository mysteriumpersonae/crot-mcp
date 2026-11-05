/**
 * Owner-configured AI provider runtime.
 *
 * All outbound HTTP calls to AI providers (models, generate, workspace) use Node native
 * fetch() directly — bypassing ExecutionGuard — because chat-runtime is owner/control-plane
 * code, not a sandboxed project agent. ExecutionGuard still governs tool invocations that
 * the AI triggers (invokeTool below). An explicit runtime deny rule for network.request is
 * respected by checking permissions.runtime before each fetch.
 */
import {
  OpenCodeSession,
  openCodeBodyDetail,
  openCodeReply,
  workspaceInventory,
  workspaceReply,
  type WorkspaceCancel,
  type WorkspaceRequest,
} from "./workspace-chat.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newSession, type AuthContext } from "../core/auth/principal.js";
import { CORE_VERSION, type CrotCore } from "../core/crot-core.js";
import type { OpenCodeKey } from "./opencode-local.js";
import { basicAuthorization, type OpenCodeServer } from "./opencode-bridge.js";
import { CrotError } from "../core/errors.js";
import { TOOLS, type ToolDefinition } from "../adapters/mcp/tools.js";
import { invokeTool } from "../adapters/mcp/invoke.js";
import { ChatEventStream } from "./chat-stream.js";
import {
  MAX_TEXT_TOOL_CALLS,
  parseToolCalls,
  toolProtocolPrompt,
  toolResultsMessage,
  type TextToolResult,
} from "./chat-tool-protocol.js";
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
import {
  DEFAULT_PROJECT_TOOL_NAMES,
  PROJECT_SEARCH_TOOL_NAME,
  projectPrompt,
  projectToolDefinitions,
  type ChatProject,
} from "./chat-project-tools.js";

export interface ProviderDiagnostic {
  code: string;
  stage: string;
  httpStatus?: number;
  networkCode?: string;
  /** Local OpenCode: the model the failed request was for. */
  model?: string;
  /** Local OpenCode: its own one-line explanation (see openCodeDetail), shown to the owner as text. */
  detail?: string;
  /** Local OpenCode's free tier: refused for the copy CROT installed (not signed in), not the owner's own. */
  source?: "owner" | "crot";
}

/**
 * Diagnostic codes for UI display:
 * NETWORK_GUARD_BLOCKED – CROT network policy blocked the request (add host to permissions.network.allow)
 * AUTH_INVALID_KEY      – server rejected the credential (HTTP 401/403)
 * LOCAL_SERVER_OFFLINE  – nothing listens at the address (connection refused)
 * NO_MODELS             – the server answered but lists no models
 * TIMEOUT               – no answer in time
 * OPERATION_FAILED      – other network or protocol error
 */
/** Socket errors worth naming to the owner (never a message or an address). */
const NETWORK_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];
/**
 * A request that never got an answer: fetch() rejects with TypeError "fetch failed" and the socket error as its
 * cause (an AggregateError when every address of a name failed), AbortSignal.timeout() with a TimeoutError.
 */
function fetchDiagnostic(error: unknown): ProviderDiagnostic {
  const e = error as { name?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  const cause = (e?.cause ?? undefined) as { name?: unknown; code?: unknown; errors?: unknown } | undefined;
  if (e?.name === "TimeoutError" || cause?.name === "TimeoutError") return { code: "TIMEOUT", stage: "network" };
  const first = Array.isArray(cause?.errors) ? (cause.errors[0] as { code?: unknown } | undefined) : undefined;
  const code = String(cause?.code ?? first?.code ?? e?.code ?? "");
  if (code === "ECONNREFUSED") return { code: "LOCAL_SERVER_OFFLINE", stage: "network", networkCode: code };
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT")
    return { code: "TIMEOUT", stage: "network", networkCode: "ETIMEDOUT" };
  return { code: "OPERATION_FAILED", stage: "network", ...(NETWORK_CODES.includes(code) ? { networkCode: code } : {}) };
}
/**
 * Never expose provider bodies, arbitrary thrown messages, URLs or credentials as diagnostics. The one exception
 * is an OpenCode server's own explanation of its failure (`detail`, `model`): CROT's local bridge and the OpenCode
 * servers of the OpenCode workspace provider produce them already bounded and redacted (openCodeDetail), so the owner sees
 * which model OpenCode refused and why.
 */
export function providerDiagnostic(error: unknown): ProviderDiagnostic {
  if (!(error instanceof CrotError)) return fetchDiagnostic(error);
  const d = error.details,
    status = Number(d?.httpStatus),
    errno = String(d?.errno ?? "");
  const local = {
    ...(typeof d?.model === "string" && d.model && d.model.length <= 256 ? { model: d.model } : {}),
    ...(typeof d?.detail === "string" && d.detail ? { detail: d.detail.slice(0, 300) } : {}),
  };
  // PERMISSION_DENIED from the ExecutionGuard (network policy block or explicit deny rule):
  // - network policy block: details.missing is [] (empty array, explicitly set)
  // - explicit runtime deny: details.missing is [] as well, but both map to NETWORK_GUARD_BLOCKED
  //   because from the UI perspective the owner blocked network access.
  // - bare PERMISSION_DENIED with no details (e.g. other service denials) → pass through as-is.
  // Starting the local OpenCode bridge refused (emergency stop, explicit runtime deny of process.start).
  if (d?.reason === "opencode_refused") return { code: "OPENCODE_START_REFUSED", stage: "local" };
  if (error.code === "PERMISSION_DENIED") {
    if (Array.isArray(d?.missing)) return { code: "NETWORK_GUARD_BLOCKED", stage: "network" };
    return { code: "PERMISSION_DENIED", stage: "network" };
  }
  // OpenCode Zen without a key: anonymous free use refused (FreeUsageLimitError).
  if (d?.reason === "free_usage_limit") return { code: "FREE_USAGE_LIMIT", stage: "probe", httpStatus: 429 };
  // The local OpenCode bridge: OpenCode's own free tier exhausted, not installed or not startable.
  if (d?.reason === "free_tier_limit")
    return {
      code: "FREE_TIER_LIMIT",
      stage: "local",
      httpStatus: 429,
      ...local,
      ...(d.source === "crot" ? { source: "crot" as const } : {}),
    };
  if (d?.reason === "opencode_not_installed") return { code: "OPENCODE_NOT_INSTALLED", stage: "local" };
  // Why it did not start (exit code and OpenCode's last error line, HTTP status, the wait), and an OpenCode
  // too old for CROT (0.x has none of the API CROT uses): the UI offers CROT's verified OpenCode.
  if (d?.reason === "opencode_start_failed") return { code: "OPENCODE_START_FAILED", stage: "local", ...local };
  if (d?.reason === "opencode_too_old") return { code: "OPENCODE_TOO_OLD", stage: "local", ...local };
  // The server answered without a single model.
  if (d?.reason === "no_models") return { code: "NO_MODELS", stage: "inventory" };
  // ECONNREFUSED: nothing listens at the address (a local server that is not running).
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
    stage: ["models", "workspace", "inventory", "local"].includes(String(d?.stage)) ? String(d?.stage) : "network",
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...local,
    ...(NETWORK_CODES.includes(errno) ? { networkCode: errno } : {}),
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
  /** OpenCode (Free & Zen): how the latest check reached OpenCode, directly ("zen") or via local OpenCode ("local"). */
  route?: "zen" | "local";
  /** OpenCode (Free & Zen): where the key of the latest check came from (never the key itself). */
  keySource?: "stored" | "env" | "auth.json";
  /** OpenCode (Free & Zen) through local OpenCode: the latest check's request with the chosen model. */
  modelCheck?: ModelCheck;
  /** OpenCode workspace agent (earlier connections): CROT starts and stops the server itself (`opencode serve`, random password). */
  managed?: boolean;
}

/**
 * OpenCode Zen's free models as local OpenCode 1.19.5 lists them without a key (GET /provider, provider
 * "opencode"), with OpenCode's own default first: shown before the first check and while local OpenCode is not
 * running. Save & Test replaces them with the live inventory, which is authoritative (OpenCode rotates its free
 * models); the models that need a key come from Zen's live /models only.
 */
export const OPENCODE_DEFAULT_MODEL = "big-pickle";
export const OPENCODE_FREE_MODELS: readonly string[] = [
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
];
export const OPENCODE_MODEL_LABELS: Readonly<Record<string, string>> = {
  "big-pickle": "Big Pickle (free)",
  "beam-free": "Beam (free)",
  "crouton-alpha-free": "Crouton Alpha (free)",
  "deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash (free)",
  "flint-40b-free": "Flint 40B (free)",
  "glm-5.3-flash-free": "GLM-5.3-Flash (free)",
  "mimo-v2.6-flash-free": "MiMo-V2.6-Flash (free)",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning (free)",
  "nemotron-3.5-super-vl-free": "Nemotron 3.5 Super VL (free)",
  "pulse-alpha-free": "Pulse Alpha (free)",
};
/** A model name for the picker: control characters and a trailing "Free" removed, "(free)" or "(Zen / Go)" added. */
function zenLabel(name: string, id: string, free: boolean): string {
  const clean =
    name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+free$/i, "")
      .trim()
      .slice(0, 128) || id;
  return `${clean} ${free ? "(free)" : "(Zen / Go)"}`;
}

/** One model of OpenCode Zen's inventory: its wire protocol, and whether it is free. */
export interface ZenModel {
  readonly id: string;
  readonly label: string;
  readonly free: boolean;
  /** "openai": /chat/completions; "anthropic": /messages. */
  readonly protocol: "openai" | "anthropic";
}

/** An inventory in picker order: the preferred (default) model first, then the free models, then by id. */
function pickerOrder(models: ZenModel[], preferred: string | undefined): ZenModel[] {
  return models.sort(
    (a, b) =>
      Number(b.id === preferred) - Number(a.id === preferred) ||
      Number(b.free) - Number(a.free) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * OpenCode Zen's /models: the models served over chat completions or Anthropic messages, OpenCode's default
 * (Big Pickle) first, then the free ones.
 * Models that need the Responses or Gemini API are left out (CROT's chat does not speak them).
 */
export function zenInventory(body: unknown): ZenModel[] {
  const out: ZenModel[] = [];
  for (const item of array(record(body).data)) {
    const m = record(item),
      id = text(m.id);
    if (!id || id.length > 256 || out.some((o) => o.id === id)) continue;
    const api = record(m.api),
      kinds = Object.keys(api);
    const protocol =
      kinds.length === 0 || "chat-completions" in api ? "openai" : "messages" in api ? "anthropic" : undefined;
    if (!protocol) continue;
    const cost = record(record(m.cost).text),
      input = record(cost.input).price,
      output = record(cost.output).price;
    const free =
      typeof input === "number" && typeof output === "number" ? input === 0 && output === 0 : id.endsWith("-free");
    out.push({ id, label: zenLabel(text(m.name), id, free), free, protocol });
  }
  return pickerOrder(out, OPENCODE_DEFAULT_MODEL);
}

/**
 * The OpenCode Zen models of a local OpenCode server (GET /provider, provider "opencode"): OpenCode's default for
 * the provider first, then the free ones. OpenCode speaks every model's protocol itself, so none is left out;
 * without a key it lists only the free ones.
 */
export function openCodeZenModels(inventory: unknown): ZenModel[] {
  const body = record(inventory);
  if (!array(body.connected).includes("opencode")) return [];
  const provider = record(array(body.all).find((p) => record(p).id === "opencode"));
  const out: ZenModel[] = [];
  for (const [key, raw] of Object.entries(record(provider.models))) {
    const m = record(raw);
    if (!key || key.length > 256 || /[\r\n\0/]/.test(key)) continue;
    const cost = record(m.cost);
    const free =
      typeof cost.input === "number" && typeof cost.output === "number"
        ? cost.input === 0 && cost.output === 0
        : key.endsWith("-free");
    out.push({ id: key, label: zenLabel(text(m.name), key, free), free, protocol: "openai" });
  }
  const preferred = text(record(body.default).opencode);
  return pickerOrder(out, preferred || OPENCODE_DEFAULT_MODEL);
}

/** A provider's non-2xx answer as an error: its status and a fixed reason, never its text. */
function providerHttpError(status: number, body: string, stage: string): CrotError {
  const reason = body.slice(0, 8192).includes("FreeUsageLimitError") ? "free_usage_limit" : undefined;
  return new CrotError("OPERATION_FAILED", "Provider request failed", {
    stage,
    httpStatus: status,
    ...(reason ? { reason } : {}),
  });
}

/**
 * OpenCode's free tier refusing the copy CROT installed: that copy has its own settings and is not signed in, so
 * the owner's own OpenCode (signed in) may still work. The error says which one was refused.
 */
function serverSource(error: unknown, server: OpenCodeServer): unknown {
  if (!(error instanceof CrotError) || error.details?.reason !== "free_tier_limit" || server.source !== "crot")
    return error;
  return new CrotError(error.code, error.message, { ...error.details, source: "crot" }, { cause: error });
}

/**
 * The owner-facing message of a failed chat turn: fixed, translatable text chosen by the provider's
 * status (never the provider's own text), or undefined for the generic message.
 */
export function chatFailure(error: unknown): string | undefined {
  if (!(error instanceof CrotError)) return undefined;
  const d = error.details ?? {},
    status = Number(d.httpStatus);
  if (d.reason === "free_usage_limit")
    return "OpenCode Zen refused free use without a key (free usage limit). Enter an OpenCode Zen API key, or connect through local OpenCode (Auto-connect).";
  if (d.reason === "free_tier_limit")
    return d.source === "crot"
      ? "OpenCode's anonymous free limit is used up: CROT's own OpenCode copy is not signed in (your OpenCode was not found or did not start). Enter an OpenCode Zen API key (opencode.ai/zen): free models work with it too."
      : "OpenCode's free usage limit is reached (OpenCode suggests its Go subscription). Try again later, or enter an OpenCode Zen API key.";
  if (d.reason === "opencode_not_installed")
    return "Local OpenCode CLI was not found. Click “Install and start OpenCode (1 click)” or enter an OpenCode Zen API key.";
  if (d.reason === "opencode_start_failed")
    return "Local OpenCode could not be started. Install the verified OpenCode into CROT with one click (your own OpenCode stays as it is), or enter an OpenCode Zen API key.";
  if (d.reason === "opencode_too_old")
    return "Your OpenCode is too old for CROT (version 1.0 or newer is needed). Install the verified OpenCode into CROT with one click, or update yours with “opencode upgrade”.";
  if (d.reason === "opencode_refused")
    return "Starting local OpenCode is blocked by the emergency stop or the runtime policy.";
  if (d.reason === "local_text_only")
    return "Local OpenCode takes text only: images are not forwarded. Remove them or enter an OpenCode Zen API key.";
  if (d.reason === "local_read_only_tools")
    return "Through local OpenCode the model can only read the open project (list, read and search files); other CROT tools are not forwarded. Turn them off or enter an OpenCode Zen API key.";
  if (error.code === "PERMISSION_DENIED") return "Network access is blocked by the runtime policy.";
  // OpenCode's own explanation follows (chatFailureDetail): the model, the exact status and why.
  if (d.stage === "local" && typeof d.detail === "string" && d.detail) return "Local OpenCode refused the request.";
  if (!Number.isInteger(status)) return undefined;
  if (status === 401) return "The provider rejected the credential (HTTP 401). Check the API key or token.";
  if (status === 403) return "The provider refused access (HTTP 403). Check the account and model permissions.";
  if (status === 404)
    return "The model or endpoint was not found (HTTP 404). Choose another model or check the API base URL.";
  if (status === 429) return "Provider rate or quota limit reached (HTTP 429). Wait and try again, or check the plan.";
  if (status === 400 || status === 422)
    return "The provider rejected the request (HTTP 400/422). The model may not support this input or tools.";
  if (status >= 500) return "The provider failed to answer (HTTP 5xx). Try again later.";
  return undefined;
}

/**
 * OpenCode's own explanation of a failed chat turn, shown after the fixed message (chatFailure): the model, the
 * exact HTTP status and OpenCode's bounded, redacted text (openCodeDetail), e.g. "glm-5.3-flash-free · HTTP 429:
 * Free usage exceeded, subscribe to Go (https://opencode.ai/go)". Only OpenCode servers produce one.
 */
export function chatFailureDetail(error: unknown): string | undefined {
  if (!(error instanceof CrotError)) return undefined;
  const d = error.details ?? {},
    detail = typeof d.detail === "string" ? d.detail.slice(0, 300) : "";
  if (!detail) return undefined;
  const status = Number(d.httpStatus),
    head = [
      typeof d.model === "string" && d.model.length <= 256 ? d.model : "",
      Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : "",
    ].filter(Boolean);
  return head.length ? `${head.join(" · ")}: ${detail}` : detail;
}

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
  /** The owner's local OpenCode (its Zen key and CROT's `opencode serve` bridge); absent: not used. */
  openCode?: OpenCodeHooks;
}
/** The owner's local OpenCode as the chat uses it. */
export interface OpenCodeHooks {
  /** The OpenCode Zen key from OPENCODE_API_KEY or OpenCode's auth.json. */
  key(): Promise<OpenCodeKey | undefined>;
  readonly bridge: {
    /** The server in use while it runs. */
    current(): OpenCodeServer | undefined;
    /** A running server: the owner's unprotected one on the default port, or CROT's own (started now). */
    ensure(signal?: AbortSignal): Promise<OpenCodeServer>;
    /** Whether the `opencode` binary is installed. */
    installed(): Promise<boolean>;
    /** The directory of model-only turns: empty and CROT-owned, never the project. */
    readonly directory: string;
  };
}
/**
 * How a turn reaches OpenCode Zen: directly (with a key, or anonymously), through local OpenCode, or "idle":
 * local OpenCode would be started, which listing the models never does.
 */
type ZenRoute =
  | { kind: "zen"; key: string; source: "stored" | "env" | "auth.json" }
  | { kind: "local"; server: OpenCodeServer }
  /** Local OpenCode is installed but not running (listing models never starts it). */
  | { kind: "idle" }
  /** No key and no OpenCode to start (listing models only; a check or a chat reports it). */
  | { kind: "missing" };
/** Save & Test's request with the chosen model through local OpenCode: accepted, or OpenCode's refusal. */
export interface ModelCheck {
  readonly model: string;
  readonly ok: boolean;
  readonly diagnostic?: ProviderDiagnostic;
}
/** An OpenCode server and the headers of every request to it (Basic auth, the OpenCode directory). */
interface OpenCodeTarget {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  /** An OpenCode server (not a Notion agent): its own explanation of a refused request is kept (openCodeBodyDetail). */
  readonly openCode?: boolean;
  /** CROT's local OpenCode bridge of OpenCode Zen: its failures belong to the "local" stage. */
  readonly local?: boolean;
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
  /** The fixed message of a failed turn (chatFailure), shown instead of the generic one. */
  failure?: string;
  /** OpenCode's own explanation of the failure (chatFailureDetail), shown after the fixed message. */
  failureDetail?: string;
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
  /** Stable session ID sent to OpenCode Zen with every turn of this thread (x-opencode-session). */
  session: string;
}
const MAX_THREADS = 16;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 120_000;
/** All threads kept in memory together (at most MAX_THREADS of them). */
const MAX_TOTAL_HISTORY_CHARS = 1_000_000;
/** One turn's request (history, tool calls and their outputs) before older tool outputs are compacted. */
const MAX_TURN_CHARS = 400_000;
const OMITTED_TOOL_OUTPUT = '{"isError":false,"omitted":"Earlier tool output removed to fit the context window."}';
const threadChars = (thread: Thread): number => thread.messages.reduce((n, m) => n + m.content.length, 0);
/**
 * Keep a turn's request within MAX_TURN_CHARS: tool outputs before `keepFrom` (earlier rounds) are
 * replaced by a short note, oldest first; the latest round's outputs and all text stay.
 */
function compactTurn(messages: unknown[], anthropic: boolean, keepFrom: number): void {
  let size = JSON.stringify(messages).length;
  for (let i = 0; i < keepFrom && size > MAX_TURN_CHARS; i++) {
    const m = messages[i] as Record<string, unknown>;
    const parts =
      anthropic && m.role === "user" && Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    const outputs = !anthropic && m.role === "tool" ? [m] : parts.filter((part) => part.type === "tool_result");
    for (const output of outputs)
      if (typeof output.content === "string" && output.content.length > OMITTED_TOOL_OUTPUT.length) {
        size -= output.content.length - OMITTED_TOOL_OUTPUT.length;
        output.content = OMITTED_TOOL_OUTPUT;
      }
  }
}
const MAX_REMEMBERED_CHARS = 48_000;
/** Tool output sent back to the model, and the share of it shown in the transcript. */
const MAX_TOOL_OUTPUT = 48_000;
const MAX_TOOL_DISPLAY = 2_000;
/** Default read size of fs_read_file in the chat, so a large file arrives in parts instead of failing. */
const CHAT_READ_LENGTH = 20_000;
const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
/** The only CROT tools offered through local OpenCode: reading the open project (list, read, stat, search). */
const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set([...DEFAULT_PROJECT_TOOL_NAMES, PROJECT_SEARCH_TOOL_NAME]);
/** Whether local OpenCode can serve the turn's tool selection (read-only project tools only). */
const localTools = (p: { tools: readonly string[] }): boolean => p.tools.every((name) => LOCAL_TOOL_NAMES.has(name));
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
/**
 * Whether the owner's own OpenCode key (OPENCODE_API_KEY, auth.json) may go to this endpoint: OpenCode Zen itself
 * (https://opencode.ai) or a loopback server, never another host typed into the endpoint field.
 */
function localKeyEndpoint(endpoint: string | undefined): boolean {
  try {
    const url = new URL(endpoint ?? CHAT_ENDPOINTS["OpenCode (Free & Zen)"]);
    if (url.username || url.password) return false;
    if (url.protocol === "https:" && url.hostname === "opencode.ai" && !url.port) return true;
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
/**
 * Headers of every OpenCode Zen request: CROT's own User-Agent and a stable session ID, as OpenCode asks of API
 * clients. The ID is random (one per thread, or per service run), never a device or account identifier.
 */
const zenSessionHeaders = (session: string): Record<string, string> => ({
  "user-agent": `CROT/${CORE_VERSION}`,
  "x-opencode-session": session,
  "x-session-id": session,
});
const denied = (): CrotError =>
  new CrotError("PERMISSION_DENIED", "Runtime policy denies network.request", {
    operation: "network.request",
    missing: [],
  });
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
  /** Wire protocol of OpenCode Zen models, from the latest inventory ("anthropic" = /messages). */
  private readonly zenProtocols = new Map<string, "openai" | "anthropic">();
  /** Free OpenCode Zen models of the latest inventory. */
  private readonly zenFree = new Set<string>(OPENCODE_FREE_MODELS);
  /** Session ID of OpenCode Zen requests outside a thread (inventory, probe): one per service run. */
  private readonly session: string = randomUUID();
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
        // Shown before the first check (OpenCode's free and Zen / Go models); the live inventory replaces them.
        ...(base === "OpenCode (Free & Zen)"
          ? {
              suggestedModels: [...OPENCODE_FREE_MODELS],
              suggestedLabels: { ...OPENCODE_MODEL_LABELS },
              ...(status && config?.route ? { route: config.route } : {}),
              ...(status === "connected" && config?.modelCheck ? { modelCheck: config.modelCheck } : {}),
              ...(credentialStored
                ? { keySource: "stored" }
                : status && config?.keySource
                  ? { keySource: config.keySource }
                  : {}),
            }
          : {}),
        ...(provider === "OpenCode" && config?.managed ? { managed: true } : {}),
      };
    });
  }
  private settings(
    provider: ChatProvider,
    key: string | undefined = this.host.credential(provider),
    session: string = this.session,
  ): { endpoint: string; headers: Record<string, string>; anthropic: boolean } {
    const config = this.host.configuration(provider);
    if (!config) return bad("Configure the chat provider first");
    const base = baseProvider(provider);
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
        ...(base === "OpenCode (Free & Zen)" ? zenSessionHeaders(session) : {}),
      },
    };
  }
  /**
   * The provider's models. `start: false` (the owner UI listing them) never starts local OpenCode: a stopped
   * managed server lists the saved model, OpenCode Zen through stopped (or missing) local OpenCode the bundled
   * free models.
   */
  async models(provider: ChatProvider, options: { start?: boolean } = {}): Promise<Record<string, unknown>> {
    const start = options.start ?? true;
    const config = this.host.configuration(provider);
    this.settings(provider);
    const base = baseProvider(provider),
      models = new Set<string>(),
      context = this.host.context();
    if (isWorkspaceProvider(provider)) {
      if (isNetworkDenied(this.host.core())) throw denied();
      if (!start && provider === "OpenCode" && config?.managed && !this.host.openCode?.bridge.current())
        return { ok: true, models: config.defaultModel ? [config.defaultModel] : [], labels: {}, idle: true };
      const target = await this.workspaceTarget(provider, context.signal);
      const result = await workspaceInventory(provider, (route, method, body, signal) =>
        this.serverRequest(target, context, route, method, body, signal),
      );
      const server = provider === "OpenCode" ? this.managedServer(provider) : undefined;
      return server ? { ...result, server: { url: server.url, managed: server.managed } } : result;
    }
    if (isNetworkDenied(this.host.core())) throw denied();
    // OpenCode (Free & Zen): the live inventory, from Zen or from local OpenCode; a failure is reported, never
    // replaced by the bundled catalog.
    if (base === "OpenCode (Free & Zen)") {
      const route = await this.zenRoute(provider, context.signal, start);
      if (route.kind === "local") return this.localInventory(route.server, context);
      if (route.kind === "idle" || route.kind === "missing") {
        const models = [...OPENCODE_FREE_MODELS];
        if (config?.defaultModel && !models.includes(config.defaultModel)) models.unshift(config.defaultModel);
        return {
          ok: true,
          models,
          labels: { ...OPENCODE_MODEL_LABELS },
          free: [...OPENCODE_FREE_MODELS],
          route: "local",
          idle: true,
          ...(route.kind === "missing" ? { installed: false } : {}),
        };
      }
      const { endpoint, headers } = this.settings(provider, route.key);
      const response = await controlFetch(`${endpoint}/models`, {
        headers,
        timeoutMs: 15000,
        signal: this.host.context().signal,
      });
      if (response.status !== 200) throw providerHttpError(response.status, "", "models");
      let body: unknown;
      try {
        body = JSON.parse(response.body);
      } catch {
        return bad("Invalid provider model inventory");
      }
      const inventory = zenInventory(body);
      if (!inventory.length)
        throw new CrotError("OPERATION_FAILED", "Provider returned no valid model inventory", { stage: "inventory" });
      this.zenProtocols.clear();
      for (const m of inventory) this.zenProtocols.set(m.id, m.protocol);
      this.learnFree(inventory);
      return {
        ok: true,
        models: inventory.map((m) => m.id),
        labels: Object.fromEntries(inventory.map((m) => [m.id, m.label])),
        free: inventory.filter((m) => m.free).map((m) => m.id),
        route: "zen",
        keySource: route.source,
      };
    }
    const { endpoint, headers } = this.settings(provider);
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const response = await controlFetch(
        `${endpoint}/models${base === "Anthropic" ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}` : ""}`,
        { headers, timeoutMs: 30000, signal: this.host.context().signal },
      );
      // A local server without /models at this address is not an OpenAI-compatible API there (usually /v1 is
      // missing): the owner is told so instead of an empty list.
      if (response.status === 404 && base === "Local HTTP")
        throw new CrotError("OPERATION_FAILED", "Model inventory endpoint not found", {
          stage: "models",
          httpStatus: 404,
        });
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
  /**
   * Save & Test of OpenCode Zen through local OpenCode: one tiny request with the chosen model, so the owner sees
   * at once whether OpenCode accepts it (its free tier limit, a model it refuses) instead of at the first chat.
   * The connection itself stands on the inventory: a refused model is reported, never a failed check. With a key
   * nothing is sent.
   */
  async verify(provider: ChatProvider, model: string): Promise<ModelCheck | undefined> {
    if (baseProvider(provider) !== "OpenCode (Free & Zen)") return undefined;
    if (isNetworkDenied(this.host.core())) throw denied();
    const context = this.host.context(),
      route = await this.zenRoute(provider, context.signal);
    if (route.kind !== "local") return undefined;
    try {
      await openCodeReply(
        `opencode/${model}`,
        "Reply with OK.",
        context.signal,
        ...this.openCodeCalls(this.localTarget(route.server), context),
        { answerOnly: true, ephemeral: true, probeMs: 8000 },
      );
      return { model, ok: true };
    } catch (error) {
      return { model, ok: false, diagnostic: { ...providerDiagnostic(serverSource(error, route.server)), model } };
    }
  }
  /**
   * How OpenCode Zen is reached: with the stored key, else with the owner's OpenCode key (OPENCODE_API_KEY,
   * auth.json), else through local OpenCode (the owner's running server, or CROT's own `opencode serve`, which
   * CROT can install). Never anonymously: Zen refuses anonymous use by clients other than OpenCode itself, so
   * without a key and without OpenCode the owner is told to install OpenCode or enter a key.
   */
  private async zenRoute(provider: ChatProvider, signal?: AbortSignal, start = true): Promise<ZenRoute> {
    const stored = this.host.credential(provider);
    if (stored) return { kind: "zen", key: stored, source: "stored" };
    const openCode = this.host.openCode;
    const local =
      openCode && localKeyEndpoint(this.host.configuration(provider)?.endpoint)
        ? await openCode.key().catch(() => undefined)
        : undefined;
    if (local) return { kind: "zen", key: local.key, source: local.source };
    if (!openCode) {
      if (!start) return { kind: "missing" };
      throw new CrotError("NOT_FOUND", "OpenCode CLI is not installed", {
        stage: "local",
        reason: "opencode_not_installed",
      });
    }
    const current = openCode.bridge.current();
    if (current) return { kind: "local", server: current };
    if (!start) return (await openCode.bridge.installed()) ? { kind: "idle" } : { kind: "missing" };
    return { kind: "local", server: await openCode.bridge.ensure(signal) };
  }
  /** The OpenCode Zen models of local OpenCode, for the Cloud LLM picker. */
  private async localInventory(server: OpenCodeServer, context: AuthContext): Promise<Record<string, unknown>> {
    const inventory = openCodeZenModels(await this.serverRequest(this.localTarget(server), context, "/provider"));
    if (!inventory.length)
      throw new CrotError("OPERATION_FAILED", "Local OpenCode offers no OpenCode Zen models", { stage: "inventory" });
    this.learnFree(inventory);
    return {
      ok: true,
      models: inventory.map((m) => m.id),
      labels: Object.fromEntries(inventory.map((m) => [m.id, m.label])),
      free: inventory.filter((m) => m.free).map((m) => m.id),
      route: "local",
      server: { url: server.url, managed: server.managed },
    };
  }
  private learnFree(inventory: readonly ZenModel[]): void {
    for (const m of inventory) if (m.free) this.zenFree.add(m.id);
  }
  /** Model-only turns of local OpenCode: its Basic auth and CROT's empty directory (never the project). */
  private localTarget(server: OpenCodeServer): OpenCodeTarget {
    return {
      endpoint: server.url,
      openCode: true,
      local: true,
      headers: {
        "content-type": "application/json",
        ...(server.password
          ? { authorization: basicAuthorization(server.username ?? "opencode", server.password) }
          : {}),
        "x-opencode-directory": encodeURIComponent(this.host.openCode!.bridge.directory),
      },
    };
  }
  /** CROT's own OpenCode server of an earlier OpenCode workspace connection made with "Start and connect". */
  private managedServer(provider: ChatProvider): OpenCodeServer | undefined {
    return provider === "OpenCode" && this.host.configuration(provider)?.managed
      ? this.host.openCode?.bridge.current()
      : undefined;
  }
  /**
   * The agent server of a workspace provider: its configured endpoint and credential, or, for a managed OpenCode,
   * CROT's own server (started when needed) working in the open project.
   */
  private async workspaceTarget(provider: ChatProvider, signal?: AbortSignal): Promise<OpenCodeTarget> {
    if (provider === "OpenCode" && this.host.configuration(provider)?.managed) {
      const openCode = this.host.openCode;
      if (!openCode) return bad("Local OpenCode is not available in this service");
      const server = await openCode.bridge.ensure(signal);
      const directory = this.host.project?.()?.root;
      return {
        endpoint: server.url,
        openCode: true,
        headers: {
          "content-type": "application/json",
          ...(server.password
            ? { authorization: basicAuthorization(server.username ?? "opencode", server.password) }
            : {}),
          ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
        },
      };
    }
    const { endpoint, headers } = this.settings(provider);
    return { endpoint, headers, openCode: provider === "OpenCode" };
  }
  /** Request and cleanup functions of one turn with an OpenCode or Notion agent server. */
  private openCodeCalls(target: OpenCodeTarget, context: AuthContext): [WorkspaceRequest, WorkspaceCancel] {
    return [
      (route, method, body, signal) => this.serverRequest(target, context, route, method, body, signal),
      (route, method = "POST") =>
        this.serverRequest(
          target,
          { ...this.host.context(), signal: AbortSignal.timeout(3000) },
          route,
          method,
          method === "POST" ? {} : undefined,
        ),
    ];
  }
  private async serverRequest(
    target: OpenCodeTarget,
    context: AuthContext,
    route: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (isNetworkDenied(this.host.core())) throw denied();
    const response = await controlFetch(target.endpoint + route, {
      method,
      headers: target.headers,
      timeoutMs: route.endsWith("/message") ? 120000 : 30000,
      signal: signal && context.signal ? AbortSignal.any([context.signal, signal]) : (signal ?? context.signal),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      const detail = target.openCode ? openCodeBodyDetail(response.body) : undefined;
      throw new CrotError("OPERATION_FAILED", "Workspace agent request failed", {
        stage: target.local ? "local" : "workspace",
        httpStatus: response.status,
        ...(detail ? { detail } : {}),
      });
    }
    try {
      const value: unknown = JSON.parse(response.body);
      return record(value);
    } catch {
      return bad("Invalid workspace agent response");
    }
  }
  /** The protocol of an OpenCode Zen model; the inventory is fetched once when a turn needs it. */
  private async zenProtocol(provider: ChatProvider, model: string): Promise<"openai" | "anthropic"> {
    if (!this.zenProtocols.has(model))
      try {
        await this.models(provider);
      } catch {
        // The chat request itself reports an unreachable provider.
      }
    return this.zenProtocols.get(model) ?? (model.startsWith("claude-") ? "anthropic" : "openai");
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
        } catch (error) {
          c.failure = chatFailure(error);
          c.failureDetail = chatFailureDetail(error);
          return bad("Chat generation failed");
        }
      })
      .then(
        () => {
          c.state = c.controller.signal.aborted ? "cancelled" : "completed";
          this.remember(c);
          // The thread keeps the history; the finished turn no longer needs its own copy.
          c.history = [];
        },
        () => {
          c.state = c.controller.signal.aborted ? "cancelled" : "failed";
          for (const block of c.blocks) if (block.type === "tool" && block.status === "running") block.status = c.state;
          // No provider response, key, prompt or thrown decoder text is reflected as an error.
          c.error =
            c.state === "failed"
              ? (c.failure ?? "Generation failed. Check provider configuration, model, Core policy and audit.")
              : undefined;
          // A stopped answer stays part of the thread; a failed turn is not remembered (the owner retries).
          if (c.state === "cancelled") this.remember(c);
          c.history = [];
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
    const thread = known ?? { id: randomUUID(), messages: [], session: randomUUID() };
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
    // Sliding window: the first exchange (the conversation's goal) stays while later turns go, oldest first.
    while (
      thread.messages.length > MAX_HISTORY_MESSAGES ||
      (thread.messages.length > 2 && threadChars(thread) > MAX_HISTORY_CHARS)
    )
      thread.messages.splice(thread.messages.length > 4 ? 2 : 0, 2);
    // All remembered threads together stay bounded: the least recently used other threads go first.
    let total = 0;
    for (const t of this.threads.values()) total += threadChars(t);
    for (const [id, t] of this.threads) {
      if (total <= MAX_TOTAL_HISTORY_CHARS) break;
      if (id === thread.id) continue;
      total -= threadChars(t);
      this.threads.delete(id);
      if (this.lastThread === id) this.lastThread = undefined;
    }
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
      ...(c.error && c.failureDetail ? { errorDetail: c.failureDetail } : {}),
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
  /**
   * The message of a turn with an agent server: agents start a new session per message, so earlier turns
   * travel in the message itself, followed by the new message and its text attachments. `limit`: the newest
   * characters of the earlier turns (Cloud LLM through local OpenCode: the whole remembered thread).
   */
  private transcript(c: Conversation, p: ChatStart, limit = 24000): string {
    const transcript = c.history
      .map((m) => `${m.role === "user" ? "Owner" : "Assistant"}: ${m.content}`)
      .join("\n\n")
      .slice(-limit);
    return (
      (transcript ? `Conversation so far:\n${transcript}\n\nNew message:\n` : "") +
      p.message +
      p.attachments.map((a) => `\n[${a.name}]\n${Buffer.from(a.data, "base64").toString("utf8")}`).join("")
    );
  }
  /**
   * One OpenCode Zen turn through local OpenCode. OpenCode's own tools stay off (they would act outside Core).
   * The model gets the whole remembered thread, the open project's prompt and only CROT's read-only project
   * tools (LOCAL_TOOL_NAMES) through the text protocol of chat-tool-protocol: their calls run through Core like
   * native tool calls, and the results go back as the next message of the same ephemeral OpenCode session.
   */
  private async localTurn(c: Conversation, p: ChatStart, context: AuthContext, server: OpenCodeServer): Promise<void> {
    try {
      await this.localExchange(c, p, context, server);
    } catch (error) {
      throw serverSource(error, server);
    }
  }
  private async localExchange(
    c: Conversation,
    p: ChatStart,
    context: AuthContext,
    server: OpenCodeServer,
  ): Promise<void> {
    if (p.attachments.some((a) => a.mime !== "text/plain"))
      throw new CrotError("OPERATION_FAILED", "Local OpenCode answers text only", { reason: "local_text_only" });
    if (!localTools(p))
      throw new CrotError("OPERATION_FAILED", "Local OpenCode offers read-only project tools only", {
        reason: "local_read_only_tools",
      });
    const project = this.host.project?.();
    // Read-only by now: the owner's selection is within LOCAL_TOOL_NAMES, the automatic ones are read-only.
    const definitions = this.turnTools(p, !!project);
    const system =
      [
        project
          ? await projectPrompt(
              this.host.core(),
              context,
              project,
              definitions.map((d) => d.name),
            )
          : "",
        definitions.length ? toolProtocolPrompt(definitions) : "",
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;
    const session = await OpenCodeSession.open(...this.openCodeCalls(this.localTarget(server), context), {
      answerOnly: true,
      ephemeral: true,
      ...(system ? { system } : {}),
    });
    try {
      let message = this.transcript(c, p, MAX_HISTORY_CHARS);
      for (let round = 0; round < 8; round++) {
        if (context.signal?.aborted || this.closed) return bad("Generation cancelled");
        const reply = await session.send(`opencode/${p.model}`, message, context.signal);
        const { text: answer, calls } = definitions.length ? parseToolCalls(reply) : { text: reply, calls: [] };
        if (answer) {
          c.blocks.push({ type: "assistant", text: answer });
          this.bounded(c);
        }
        if (!calls.length) return;
        const results: TextToolResult[] = [];
        for (const [index, call] of calls.entries()) {
          if (context.signal?.aborted || this.closed) return bad("Generation cancelled");
          const refused = call.invalid ?? (index >= MAX_TEXT_TOOL_CALLS ? "Too many tool calls in one answer" : "");
          results.push({
            name: call.name,
            ...(refused
              ? { output: JSON.stringify({ isError: true, message: refused }), failed: true }
              : await this.runTool(c, definitions, call, context)),
          });
        }
        message = toolResultsMessage(results);
      }
      return bad("Chat tool round limit reached");
    } finally {
      await session.close();
    }
  }
  /** The tools of a turn: the owner's selection, plus the open project's read-only tools unless turned off. */
  private turnTools(p: ChatStart, project: boolean): ToolDefinition[] {
    const automatic =
      project && p.projectTools ? projectToolDefinitions().filter((t) => !p.tools.includes(t.name)) : [];
    return [...TOOLS.filter((t) => p.tools.includes(t.name)), ...automatic];
  }
  /**
   * One tool call of the model through Core, shown as a tool block: only a tool offered for the turn runs;
   * the result (or why it did not run) as JSON text for the model, bounded by MAX_TOOL_OUTPUT.
   */
  private async runTool(
    c: Conversation,
    definitions: readonly ToolDefinition[],
    call: { name: string; arguments: string },
    context: AuthContext,
  ): Promise<{ output: string; failed: boolean }> {
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
    return { output, failed: !!result.isError || tooLarge };
  }
  private async generate(c: Conversation, p: ChatStart, context: AuthContext): Promise<void> {
    if (isWorkspaceProvider(p.provider)) {
      const target = await this.workspaceTarget(p.provider, context.signal);
      const reply = await workspaceReply(
        p.provider,
        p.model,
        this.transcript(c, p),
        context.signal,
        ...this.openCodeCalls(target, context),
      );
      c.blocks.push({ type: "assistant", text: reply });
      this.bounded(c);
      return;
    }
    const zen = baseProvider(p.provider) === "OpenCode (Free & Zen)";
    const route = zen ? await this.zenRoute(p.provider, context.signal) : undefined;
    if (route?.kind === "local") return this.localTurn(c, p, context, route.server);
    const key = route?.kind === "zen" ? route.key : undefined,
      session = this.threads.get(c.thread)?.session ?? this.session;
    const settings = this.settings(p.provider, key, session);
    const { endpoint } = settings;
    let { headers, anthropic } = settings;
    // OpenCode Zen serves Claude and Qwen models over Anthropic messages, the others over chat completions.
    if (zen && (await this.zenProtocol(p.provider, p.model)) === "anthropic") {
      anthropic = true;
      headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(key ? { "x-api-key": key } : {}),
        ...zenSessionHeaders(session),
      };
    }
    const content: unknown[] = [{ type: "text", text: p.message }];
    for (const a of p.attachments) {
      const bytes = Buffer.from(a.data, "base64");
      if (a.mime === "text/plain") content.push({ type: "text", text: `[${a.name}]\n${bytes.toString("utf8")}` });
      else if (anthropic) content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.data } });
      else content.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data}` } });
    }
    const project = this.host.project?.();
    // The open project's read-only tools are on by default; the owner's tool selection adds to them.
    let definitions = this.turnTools(p, !!project);
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
    let toolFallback = definitions.length > 0 && p.tools.length === 0;
    // Where the latest round's messages start: its tool outputs are kept whole (compactTurn).
    let latest = messages.length;
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
      compactTurn(messages, anthropic, latest);
      latest = messages.length;
      let streamingOk = false;
      // The start of a refused request's body: classified (chatFailure), never shown.
      const refusal: Buffer[] = [];
      let refusalBytes = 0;
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
          else if (refusalBytes < 8192) {
            refusal.push(chunk);
            refusalBytes += chunk.length;
          }
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
      if (!streamingOk || streamStatus < 200 || streamStatus >= 300) {
        const error = providerHttpError(streamStatus, Buffer.concat(refusal).toString("utf8"), "chat");
        // A free model refused by Zen before any answer (429/403): the turn once more through local OpenCode.
        if (
          zen &&
          (streamStatus === 429 || streamStatus === 403) &&
          this.zenFree.has(p.model) &&
          localTools(p) &&
          p.attachments.every((a) => a.mime === "text/plain") &&
          c.blocks.every((b) => b.type === "user" || (b.type === "assistant" && !b.text))
        ) {
          const server = await this.host.openCode?.bridge.ensure(context.signal).catch(() => undefined);
          if (server) {
            c.blocks.pop();
            return this.localTurn(c, p, context, server);
          }
        }
        throw error;
      }
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
        const { output, failed } = await this.runTool(c, definitions, call, context);
        if (anthropic)
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: output,
            is_error: failed,
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
