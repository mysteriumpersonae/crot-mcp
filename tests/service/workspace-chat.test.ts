import { describe, expect, it } from "vitest";
import { workspaceInventory, workspaceReply, type WorkspaceRequest } from "../../src/service/workspace-chat.js";
describe("native workspace agent adapters", () => {
  it("lists only connected OpenCode model providers and checks native health", async () => {
    const routes: string[] = [];
    const r = await workspaceInventory("OpenCode", async (route) => {
      routes.push(route);
      return route.endsWith("health")
        ? { healthy: true }
        : {
            connected: ["cloud"],
            all: [
              { id: "cloud", models: { a: { name: "Model A" } } },
              { id: "offline", models: { b: {} } },
            ],
          };
    });
    expect(routes).toEqual(["/global/health", "/provider"]);
    expect(r.models).toEqual(["cloud/a"]);
    expect(r.labels).toEqual({ "cloud/a": "Model A" });
    await expect(workspaceInventory("OpenCode", async () => ({ healthy: false }))).rejects.toThrow("unhealthy");
  });
  it("paginates Notion agent access and excludes inactive/non-agent records", async () => {
    let page = 0;
    const r = await workspaceInventory("Notion Agents", async (_r, _m, b) => {
      expect(_m).toBe("POST");
      if (page++) {
        expect(b).toMatchObject({ start_cursor: "next" });
        return {
          results: [{ id: "second", agent_type: "custom_agent", status: "active", name: "Second" }],
          has_more: false,
        };
      }
      return {
        results: [
          { id: "first", agent_type: "custom_agent", status: "active", name: "First" },
          { id: "paused", agent_type: "custom_agent", status: "paused" },
          { id: "page", status: "active" },
        ],
        has_more: true,
        next_cursor: "next",
      };
    });
    expect(r.models).toEqual(["first", "second"]);
  });
  it("uses native OpenCode session/message API and never a fake /v1/models", async () => {
    const seen: unknown[] = [];
    const cancelled: string[] = [];
    const request: WorkspaceRequest = async (route, method, body) => {
      seen.push({ route, method, body });
      return route === "/session"
        ? { id: "s1" }
        : {
            info: {},
            parts: [
              { type: "reasoning", text: "not a user answer" },
              { type: "text", text: "Native answer" },
            ],
          };
    };
    expect(
      await workspaceReply("OpenCode", "anthropic/claude-model", "Hello", undefined, request, async (r) => {
        cancelled.push(r);
      }),
    ).toBe("Native answer");
    expect(seen).toEqual([
      { route: "/session", method: "POST", body: { title: "CROT chat" } },
      {
        route: "/session/s1/message",
        method: "POST",
        body: { model: { providerID: "anthropic", modelID: "claude-model" }, parts: [{ type: "text", text: "Hello" }] },
      },
    ]);
    expect(cancelled).toEqual([]);
  });
  it("aborts OpenCode after an upstream failure without auto-approving tools", async () => {
    const cancelled: string[] = [];
    await expect(
      workspaceReply(
        "OpenCode",
        "p/m",
        "Hello",
        undefined,
        async (route) => {
          if (route === "/session") return { id: "s" };
          throw Error("secret provider response");
        },
        async (r) => {
          cancelled.push(r);
        },
      ),
    ).rejects.toThrow();
    expect(cancelled).toEqual(["/session/s/abort"]);
  });
  it("reads Notion session replies in sequence across event pages", async () => {
    const seen: string[] = [];
    let page = 0;
    const reply = await workspaceReply(
      "Notion Agents",
      "agent",
      "Hello",
      undefined,
      async (route, _method, body) => {
        seen.push(route);
        if (route === "/sessions") {
          expect(body).toEqual({ agent_id: "agent", message: "Hello" });
          return { id: "s", status: "completed" };
        }
        if (page++) {
          expect(body).toMatchObject({ start_cursor: "next" });
          return { results: [{ sequence: 1, content: [{ type: "text", text: "First" }] }], has_more: false };
        }
        return {
          results: [{ sequence: 2, content: [{ type: "text", text: "Second" }, { type: "image" }] }],
          has_more: true,
          next_cursor: "next",
        };
      },
      async () => {
        throw Error("must not cancel completed");
      },
    );
    expect(reply).toBe("First\nSecond");
    expect(seen).toEqual(["/sessions", "/sessions/s/events/query", "/sessions/s/events/query"]);
  });
  it("never auto-approves Notion required actions; cancels pending turn", async () => {
    const routes: string[] = [];
    await expect(
      workspaceReply(
        "Notion Agents",
        "a",
        "Hello",
        undefined,
        async () => ({ id: "s", status: "requires_action" }),
        async (route) => {
          routes.push(route);
        },
      ),
    ).rejects.toThrow("requires approval");
    expect(routes).toEqual(["/sessions/s/cancel"]);
  });
  it("honors abort during Notion polling and calls remote cancellation", async () => {
    const abort = new AbortController(),
      routes: string[] = [];
    await expect(
      workspaceReply(
        "Notion Agents",
        "a",
        "Hello",
        abort.signal,
        async () => {
          abort.abort();
          return { id: "s", status: "queued" };
        },
        async (route) => {
          routes.push(route);
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(routes).toEqual(["/sessions/s/cancel"]);
  });
  it("rejects malicious session paths and empty replies", async () => {
    const cancelled: string[] = [];
    await expect(
      workspaceReply(
        "OpenCode",
        "p/m",
        "Hi",
        undefined,
        async () => ({ id: "../../evil" }),
        async (r) => {
          cancelled.push(r);
        },
      ),
    ).rejects.toThrow("Invalid workspace session");
    expect(cancelled).toEqual([]);
    await expect(
      workspaceReply(
        "Notion Agents",
        "a",
        "Hi",
        undefined,
        async (route) => (route === "/sessions" ? { id: "s", status: "completed" } : { results: [] }),
        async () => {},
      ),
    ).rejects.toThrow("no usable answer");
  });
});
