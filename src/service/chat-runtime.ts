/** Owner-configured providers; all HTTP and tool calls use the existing Core guard. */
import { workspaceInventory, workspaceReply } from "./workspace-chat.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newSession, type AuthContext } from "../core/auth/principal.js";
import type { CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import { TOOLS } from "../adapters/mcp/tools.js";
import { invokeTool } from "../adapters/mcp/invoke.js";
import { ChatEventStream } from "./chat-stream.js";
import { ChatStartSchema, type ChatProvider, type ChatStart } from "./chat-protocol.js";

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
  // PERMISSION_DENIED from the ExecutionGuard means the network policy blocked it.
  if (error.code === "PERMISSION_DENIED") {
    return { code: "NETWORK_GUARD_BLOCKED", stage: "network" };
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
    ...(
      [
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
        : {}
    ),
  };
}

export interface ChatProviderConfig {
  endpoint: string;
  defaultModel?: string;
  username?: string;
  connectionError?: ProviderDiagnostic;
  checkedAt?: string;
  connectionStatus?: "connected" | "failed";
}

export const CHAT_ENDPOINTS: Record<ChatProvider, string> = {
  OpenAI: "https://api.openai.com/v1",
  Anthropic: "https://api.anthropic.com/v1",
  "Google Gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  OpenRouter: "https://openrouter.ai/api/v1",
  River: "https://api.river.ai/v1",
  "OpenAI-compatible": "",
  "Local HTTP": "http://127.0.0.1:1234/v1",
  OpenCode: "http://127.0.0.1:4096",
  "Notion Agents": "https://api.notion.com/v1",
};

/**
 * Hosts that CROT auto-adds to network.allow when an owner saves a provider.
 * Loopback addresses are listed explicitly because a name rule alone would not
 * allow them (NetworkPolicy requires an explicit IP/CIDR rule for non-public addresses).
 */
export const PROVIDER_NETWORK_HOSTS: Partial<Record<ChatProvider, readonly string[]>> = {
  OpenAI: ["api.openai.com"],
  Anthropic: ["api.anthropic.com"],
  "Google Gemini": ["generativelanguage.googleapis.com"],
  OpenRouter: ["openrouter.ai"],
  River: ["api.river.ai"],
  "Notion Agents": ["api.notion.com"],
  "Local HTTP": ["127.0.0.1:1234", "localhost:1234"],
  OpenCode: ["127.0.0.1:4096", "localhost:4096"],
};

interface Host {
  core(): CrotCore;
  configuration(provider: ChatProvider): ChatProviderConfig | undefined;
  credential(provider: ChatProvider): string | undefined;
  context(): AuthContext;
  run(context: AuthContext, work: (context: AuthContext) => Promise<void>): Promise<unknown>;
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
  private closed = false;
  constructor(private readonly host: Host) {}
  get running(): boolean {
    return [...this.conversations.values()].some((c) => c.state === "running");
  }
  get current(): string | undefined {
    return [...this.conversations.keys()].at(-1);
  }
  providers(): Record<string, unknown>[] {
    return (Object.keys(CHAT_ENDPOINTS) as ChatProvider[]).map((provider) => ({
      provider,
      endpoint: this.host.configuration(provider)?.endpoint ?? CHAT_ENDPOINTS[provider],
      defaultModel: this.host.configuration(provider)?.defaultModel,
      username: this.host.configuration(provider)?.username,
      credentialRequired: provider !== "Local HTTP" && provider !== "OpenCode",
      kind: provider === "OpenCode" || provider === "Notion Agents" ? "workspace" : "model",
      connectionError: this.host.configuration(provider)?.connectionError,
      checkedAt: this.host.configuration(provider)?.checkedAt,
      connectionStatus: this.host.configuration(provider)?.connectionStatus,
      configured: !!this.host.configuration(provider),
      credentialStored: !!this.host.credential(provider),
    }));
  }
  private settings(provider: ChatProvider): { endpoint: string; headers: Record<string, string> } {
    const config = this.host.configuration(provider);
    if (!config) return bad("Configure the chat provider first");
    const key = this.host.credential(provider);
    if (provider !== "Local HTTP" && provider !== "OpenCode" && !key)
      return bad("Provider credential is not configured");
    return {
      endpoint: chatEndpoint(config.endpoint),
      headers: {
        "content-type": "application/json",
        ...(provider === "OpenCode"
          ? key
            ? { authorization: `Basic ${Buffer.from(`${config.username || "opencode"}:${key}`).toString("base64")}` }
            : {}
          : provider === "Notion Agents"
            ? { "Notion-Version": "2026-03-11", authorization: `Bearer ${key}` }
            : provider === "Anthropic"
              ? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
              : key
                ? { authorization: `Bearer ${key}` }
                : {}),
      },
    };
  }
  async models(provider: ChatProvider): Promise<Record<string, unknown>> {
    const { endpoint, headers } = this.settings(provider),
      models = new Set<string>();
    if (provider === "OpenCode" || provider === "Notion Agents")
      return workspaceInventory(provider, (route, method, body) =>
        this.workspaceRequest(provider, this.host.context(), route, method, body),
      );
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const response = await this.host.core().network.request(this.host.context(), {
        url: `${endpoint}/models${provider === "Anthropic" ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}` : ""}`,
        headers,
        followRedirects: false,
        maxResponseBytes: 256000,
      });
      if (response.status !== 200 || response.truncated)
        throw new CrotError("OPERATION_FAILED", "Model inventory request failed", {
          stage: "models",
          httpStatus: response.status,
          truncated: response.truncated,
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
      if (provider !== "Anthropic" || body.has_more !== true) return { ok: true, models: [...models].sort() };
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
    const { endpoint, headers } = this.settings(provider);
    const response = await this.host.core().network.request(context, {
      url: endpoint + route,
      timeoutMs: route.endsWith("/message") ? 120000 : 30000,
      method,
      headers,
      followRedirects: false,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      maxResponseBytes: 256000,
    });
    if (response.status < 200 || response.status >= 300 || response.truncated)
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
    if (
      (p.provider === "OpenCode" || p.provider === "Notion Agents") &&
      (p.tools.length || p.attachments.some((a) => a.mime !== "text/plain"))
    )
      return bad(
        "Workspace agents accept text only; CROT tool grants are not forwarded. Use the workspace agent permissions.",
      );
    this.settings(p.provider);
    if (new Set(p.tools).size !== p.tools.length || p.tools.some((name) => !TOOLS.some((t) => t.name === name)))
      return bad("Unknown or duplicate tool selection");
    if ([...this.conversations.values()].some((c) => c.state === "running"))
      return bad("Stop the active generation first");
    while (this.conversations.size >= 8) this.conversations.delete(this.conversations.keys().next().value!);
    const c: Conversation = {
      id: randomUUID(),
      provider: p.provider,
      model: p.model,
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
        },
        () => {
          c.state = c.controller.signal.aborted ? "cancelled" : "failed";
          for (const block of c.blocks) if (block.type === "tool" && block.status === "running") block.status = c.state;
          // No provider response, key, prompt or thrown decoder text is reflected as an error.
          c.error =
            c.state === "failed"
              ? "Generation failed. Check provider configuration, model, Core policy and audit."
              : undefined;
        },
      );
    return { ok: true, id: c.id };
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
    if (p.provider === "OpenCode" || p.provider === "Notion Agents") {
      const provider = p.provider;
      const message =
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
    const anthropic = p.provider === "Anthropic",
      { endpoint, headers } = this.settings(p.provider);
    const content: unknown[] = [{ type: "text", text: p.message }];
    for (const a of p.attachments) {
      const bytes = Buffer.from(a.data, "base64");
      if (a.mime === "text/plain") content.push({ type: "text", text: `[${a.name}]\n${bytes.toString("utf8")}` });
      else if (anthropic) content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.data } });
      else content.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data}` } });
    }
    const messages: unknown[] = [{ role: "user", content }];
    const definitions = TOOLS.filter((t) => p.tools.includes(t.name));
    const tools = definitions.map((t) => {
      const schema = z.toJSONSchema(t.inputSchema, { io: "input", unrepresentable: "any" });
      return anthropic
        ? { name: t.name, description: t.description, input_schema: schema }
        : { type: "function", function: { name: t.name, description: t.description, parameters: schema } };
    });
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
      let streaming = false;
      const response = await this.host.core().network.request(
        context,
        {
          url: `${endpoint}/${anthropic ? "messages" : "chat/completions"}`,
          method: "POST",
          headers,
          followRedirects: false,
          body: JSON.stringify({
            model: p.model,
            messages,
            stream: true,
            ...(p.provider === "OpenAI" ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
            ...(tools.length ? { tools } : {}),
          }),
          maxResponseBytes: 1024 * 1024,
        },
        {
          start: (status, type) => {
            streaming = status >= 200 && status < 300 && type.includes("text/event-stream");
          },
          data: (chunk) => {
            if (streaming) stream.push(chunk);
          },
        },
      );
      if (!streaming || response.truncated || response.status < 200 || response.status >= 300)
        return bad(`Provider streaming failed (HTTP ${response.status})`);
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
                  input: JSON.parse(call.arguments || "{}"),
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
        const block: Block = { type: "tool", name: call.name, status: "running", text: call.arguments };
        c.blocks.push(block);
        this.bounded(c);
        const definition = definitions.find((d) => d.name === call.name);
        const result = definition
          ? await invokeTool(this.host.core(), () => context, {
              definition,
              args: JSON.parse(call.arguments || "{}"),
              request: {},
              signal: context.signal,
            })
          : { isError: true, content: [{ type: "text", text: "Tool was not enabled by the user" }] };
        if (context.signal?.aborted) return bad("Generation cancelled");
        const serialized = JSON.stringify(result);
        const tooLarge = serialized.length > 16000;
        const output = !tooLarge
          ? serialized
          : JSON.stringify({ isError: true, message: "Tool result exceeded the chat transfer limit" });
        block.status = result.isError || tooLarge ? "failed" : "completed";
        block.text += `\n${output}`;
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
  }
}
