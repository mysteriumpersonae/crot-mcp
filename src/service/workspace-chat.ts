/** Native workspace agent APIs, not data connectors or fabricated OpenAI endpoints.
 * All requests are delegated to the guarded Core client; no SDK bypass. */
import { setTimeout as delay } from "node:timers/promises";
import { CrotError } from "../core/errors.js";
type WorkspaceProvider = "OpenCode" | "Notion Agents";
type Json = Record<string, unknown>;
/** One request to the agent server; `signal` ends it early in addition to the turn's own signal. */
export type WorkspaceRequest = (
  route: string,
  method?: "GET" | "POST" | "DELETE",
  body?: unknown,
  signal?: AbortSignal,
) => Promise<Json>;
/** Cleanup after a turn (abort, cancel, delete) with its own short deadline; failures are ignored. */
export type WorkspaceCancel = (route: string, method?: "POST" | "DELETE") => Promise<unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const fail = (message: string): never => {
  throw new CrotError("OPERATION_FAILED", message);
};
const safeId = (id: unknown): string => {
  const s = str(id);
  if (!s || s.length > 256 || !/^[\w-]+$/.test(s)) return fail("Invalid workspace session ID");
  return s;
};
export async function workspaceInventory(provider: WorkspaceProvider, request: WorkspaceRequest): Promise<Json> {
  const models: string[] = [],
    labels: Record<string, string> = {};
  if (provider === "OpenCode") {
    const health = await request("/global/health");
    if (health.healthy !== true) return fail("OpenCode server is unhealthy");
    const inventory = await request("/provider"),
      connected = list(inventory.connected);
    for (const raw of list(inventory.all)) {
      const p = obj(raw),
        providerId = str(p.id);
      if (!connected.includes(providerId) || !providerId || providerId.includes("/")) continue;
      for (const [key, rawModel] of Object.entries(obj(p.models))) {
        const id = `${providerId}/${key}`;
        if (id.length > 256 || /[\r\n\0]/.test(id)) continue;
        models.push(id);
        labels[id] = (str(obj(rawModel).name) || id).slice(0, 256);
      }
    }
  } else {
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const result = await request("/agents/query", "POST", {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      if (!Array.isArray(result.results)) return fail("Invalid Notion agent inventory");
      for (const raw of result.results) {
        const a = obj(raw),
          id = str(a.id);
        if (a.agent_type !== "custom_agent" || a.status !== "active" || !id || id.length > 256) continue;
        models.push(id);
        labels[id] = (str(a.name) || id).slice(0, 256);
      }
      if (result.has_more !== true) return { ok: true, models, labels };
      const next = str(result.next_cursor);
      if (!next || next === cursor) return fail("Invalid agent pagination");
      cursor = next;
    }
    return fail("Agent inventory exceeds pagination limit");
  }
  return { ok: true, models: models.sort(), labels };
}
/**
 * OpenCode's built-in tools, all turned off for a model-only answer (Cloud LLM through local OpenCode):
 * "*" covers every tool, the names cover servers that match tool names exactly.
 */
export const OPENCODE_TOOL_IDS: readonly string[] = [
  "*",
  "apply_patch",
  "bash",
  "codesearch",
  "edit",
  "glob",
  "grep",
  "invalid",
  "list",
  "lsp",
  "multiedit",
  "patch",
  "question",
  "read",
  "skill",
  "task",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
];
export interface OpenCodeTurn {
  /** Turn every OpenCode tool off: the model only answers (Cloud LLM through local OpenCode). */
  readonly answerOnly?: boolean;
  /** Delete the OpenCode session afterwards, so CROT's turns do not fill the owner's OpenCode history. */
  readonly ephemeral?: boolean;
  /** Probe: after this long without a refusal the turn is stopped and counts as accepted (returns ""). */
  readonly probeMs?: number;
  /** How often the session status is checked for a refusal (free usage limit, long retry). */
  readonly watchMs?: number;
  /**
   * CROT's instructions for every message of the session (the open project, CROT tools). OpenCode adds them to
   * its own system prompt for that message only, so each message carries them again.
   */
  readonly system?: string;
}
/** A failed OpenCode turn (info.error) as a fixed error: status and reason only, never OpenCode's text. */
function openCodeError(error: Json): CrotError {
  const name = str(error.name),
    data = obj(error.data),
    status = Number(data.statusCode);
  if (name === "MessageAbortedError") return new CrotError("OPERATION_FAILED", "OpenCode turn was aborted");
  const httpStatus = name === "ProviderAuthError" ? 401 : Number.isInteger(status) ? status : undefined;
  const free = httpStatus === 429 && /free|subscribe/i.test(`${str(data.message)} ${str(data.responseBody)}`);
  return new CrotError("OPERATION_FAILED", "OpenCode agent failed", {
    stage: "local",
    ...(httpStatus && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(free ? { reason: "free_tier_limit" } : {}),
  });
}
/**
 * One CROT turn with an OpenCode server (`opencode serve`): a new session whose messages follow each other
 * (OpenCode keeps them, so a later message sees the earlier ones and their answers), then closed. While an
 * answer is pending, the session status is watched: OpenCode retries a refused model call instead of failing
 * (e.g. "Free usage exceeded" with action.reason "free_tier_limit", or a retry scheduled minutes ahead), so
 * such a message is aborted at once and reported as a fixed limit error instead of waiting for the timeout.
 */
export class OpenCodeSession {
  private constructor(
    readonly id: string,
    private readonly request: WorkspaceRequest,
    private readonly cancel: WorkspaceCancel,
    private readonly options: OpenCodeTurn,
  ) {}
  static async open(
    request: WorkspaceRequest,
    cancel: WorkspaceCancel,
    options: OpenCodeTurn = {},
  ): Promise<OpenCodeSession> {
    const id = safeId((await request("/session", "POST", { title: "CROT chat" })).id);
    return new OpenCodeSession(id, request, cancel, options);
  }
  /** One message and OpenCode's text answer; a message that fails is aborted on the server. */
  async send(model: string, message: string, signal: AbortSignal | undefined): Promise<string> {
    if (signal?.aborted) return fail("Workspace generation cancelled");
    const split = model.indexOf("/");
    if (split < 1 || split === model.length - 1) return fail("Select an OpenCode provider/model");
    const { request, options, id: session } = this;
    const stop = new AbortController();
    let completed = false,
      refusal: CrotError | undefined,
      accepted = false;
    const watcher = (async () => {
      const started = Date.now();
      while (!stop.signal.aborted) {
        await delay(options.watchMs ?? 1000, undefined, { signal: stop.signal }).catch(() => undefined);
        if (stop.signal.aborted) return;
        let state: Json;
        try {
          state = obj((await request("/session/status", "GET", undefined, stop.signal))[session]);
        } catch {
          continue;
        }
        if (state.type === "retry") {
          const action = obj(state.action),
            next = Number(state.next),
            freeTier = action.reason === "free_tier_limit";
          if (freeTier || (Number.isFinite(next) && next - Date.now() > 60_000) || Number(state.attempt) >= 5) {
            refusal = new CrotError("OPERATION_FAILED", "OpenCode refused the model request", {
              stage: "local",
              httpStatus: 429,
              ...(freeTier ? { reason: "free_tier_limit" } : {}),
            });
            stop.abort();
            return;
          }
        } else if (options.probeMs && Date.now() - started >= options.probeMs) {
          accepted = true;
          stop.abort();
          return;
        }
      }
    })();
    try {
      let result: Json | undefined;
      try {
        result = await request(
          `/session/${session}/message`,
          "POST",
          {
            model: { providerID: model.slice(0, split), modelID: model.slice(split + 1) },
            ...(options.system ? { system: options.system } : {}),
            ...(options.answerOnly ? { tools: Object.fromEntries(OPENCODE_TOOL_IDS.map((id) => [id, false])) } : {}),
            parts: [{ type: "text", text: message }],
          },
          stop.signal,
        );
      } catch (error) {
        if (!refusal && !accepted) throw error;
      }
      if (refusal) throw refusal;
      if (accepted || !result) return "";
      const failure = obj(obj(result.info).error);
      if (Object.keys(failure).length) throw openCodeError(failure);
      const reply = list(result.parts)
        .filter((p) => obj(p).type === "text")
        .map((p) => str(obj(p).text))
        .join("\n");
      if (!reply || reply.length > 128000 || signal?.aborted) return fail("OpenCode returned no usable answer");
      completed = true;
      return reply;
    } finally {
      stop.abort();
      await watcher;
      // Abort on timeout/error/stop/refusal/probe; never auto-approve workspace actions. Cleanup uses Core policy.
      if (!completed) await this.cancel(`/session/${session}/abort`).catch(() => {});
    }
  }
  /** The end of the turn: an ephemeral session is deleted (a failed cleanup is ignored). */
  async close(): Promise<void> {
    if (this.options.ephemeral) await this.cancel(`/session/${this.id}`, "DELETE").catch(() => {});
  }
}
/** One message in a new OpenCode session (a workspace turn, a probe or a model-only answer). */
export async function openCodeReply(
  model: string,
  message: string,
  signal: AbortSignal | undefined,
  request: WorkspaceRequest,
  cancel: WorkspaceCancel,
  options: OpenCodeTurn = {},
): Promise<string> {
  if (signal?.aborted) return fail("Workspace generation cancelled");
  const split = model.indexOf("/");
  if (split < 1 || split === model.length - 1) return fail("Select an OpenCode provider/model");
  const session = await OpenCodeSession.open(request, cancel, options);
  try {
    return await session.send(model, message, signal);
  } finally {
    await session.close();
  }
}
export async function workspaceReply(
  provider: WorkspaceProvider,
  model: string,
  message: string,
  signal: AbortSignal | undefined,
  request: WorkspaceRequest,
  cancel: WorkspaceCancel,
): Promise<string> {
  if (provider === "OpenCode") return openCodeReply(model, message, signal, request, cancel);
  let session = "",
    completed = false;
  try {
    if (signal?.aborted) return fail("Workspace generation cancelled");
    const created = await request("/sessions", "POST", { agent_id: model, message });
    session = safeId(created.id);
    let state = created;
    const deadline = Date.now() + 120000;
    while (["queued", "in_progress"].includes(str(state.status))) {
      if (Date.now() >= deadline || signal?.aborted) return fail("Workspace generation timed out or cancelled");
      await delay(750, undefined, { signal });
      state = await request(`/sessions/${session}`);
    }
    if (state.status !== "completed")
      return fail(
        state.status === "requires_action"
          ? "Agent requires approval in Notion; no action is auto-approved"
          : "Notion agent did not complete",
      );
    const events: Json[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const result = await request(`/sessions/${session}/events/query`, "POST", {
        filter: { property: "type", event_type: { equals: "agent.message" } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      events.push(...list(result.results).map(obj));
      if (result.has_more !== true) break;
      const next = str(result.next_cursor);
      if (!next || next === cursor || page === 9) return fail("Agent response exceeds pagination limit");
      cursor = next;
    }
    const reply = events
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .flatMap((e) => list(e.content))
      .filter((p) => obj(p).type === "text")
      .map((p) => str(obj(p).text))
      .join("\n");
    if (!reply || reply.length > 128000 || signal?.aborted) return fail("Agent returned no usable answer");
    completed = true;
    return reply;
  } finally {
    // Cancel on timeout/error/stop, never auto-approve workspace actions. Cleanup still uses Core policy.
    if (session && !completed) await cancel(`/sessions/${session}/cancel`).catch(() => {});
  }
}
