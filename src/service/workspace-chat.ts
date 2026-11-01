/** Native workspace agent APIs, not data connectors or fabricated OpenAI endpoints.
 * All requests are delegated to the guarded Core client; no SDK bypass. */
import { setTimeout as delay } from "node:timers/promises";
import { CrotError } from "../core/errors.js";
type WorkspaceProvider = "OpenCode" | "Notion Agents";
type Json = Record<string, unknown>;
export type WorkspaceRequest = (route: string, method?: "GET" | "POST", body?: unknown) => Promise<Json>;
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
export async function workspaceReply(
  provider: WorkspaceProvider,
  model: string,
  message: string,
  signal: AbortSignal | undefined,
  request: WorkspaceRequest,
  cancel: (route: string) => Promise<unknown>,
): Promise<string> {
  let session = "",
    completed = false;
  try {
    if (signal?.aborted) return fail("Workspace generation cancelled");
    if (provider === "OpenCode") {
      const split = model.indexOf("/");
      if (split < 1 || split === model.length - 1) return fail("Select an OpenCode provider/model");
      session = safeId((await request("/session", "POST", { title: "CROT chat" })).id);
      const result = await request(`/session/${session}/message`, "POST", {
        model: { providerID: model.slice(0, split), modelID: model.slice(split + 1) },
        parts: [{ type: "text", text: message }],
      });
      if (obj(result.info).error) return fail("OpenCode agent failed");
      const reply = list(result.parts)
        .filter((p) => obj(p).type === "text")
        .map((p) => str(obj(p).text))
        .join("\n");
      if (!reply || reply.length > 128000 || signal?.aborted) return fail("OpenCode returned no usable answer");
      completed = true;
      return reply;
    }
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
    if (session && !completed)
      await cancel(
        `/session${provider === "Notion Agents" ? "s" : ""}/${session}/${provider === "OpenCode" ? "abort" : "cancel"}`,
      ).catch(() => {});
  }
}
