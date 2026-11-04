import http from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRuntime, customLabel, customSlug } from "../../src/service/chat-runtime.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext, waitFor, type TempDirs } from "../helpers.js";

interface Body {
  model: string;
  system?: string;
  messages: { role: string; content: unknown; tool_call_id?: string }[];
  tools?: { name?: string; function?: { name: string } }[];
}
const toolNames = (body: Body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);

/**
 * An OpenAI/Anthropic SSE fixture. The owner's message decides the reply: "read-readme" and
 * "search-needle" answer with a tool call first; "reject-tools" rejects any request with tools.
 */
function fixture() {
  const bodies: Body[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
      bodies.push(body);
      const anthropic = (req.url ?? "").includes("/messages");
      const last = body.messages.at(-1)!;
      const owner = JSON.stringify(
        [...body.messages]
          .reverse()
          .find((m) => m.role === "user" && !JSON.stringify(m.content).includes("tool_result"))?.content,
      );
      const firstRound = last.role === "user" && !JSON.stringify(last.content).includes("tool_result");
      if (owner.includes("reject-tools") && body.tools?.length) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"tools unsupported"}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (data: unknown, event = "") =>
        res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
      const call = owner.includes("read-readme")
        ? { name: "fs_read_file", args: { path: "README.md" } }
        : owner.includes("search-needle")
          ? { name: "project_search_files", args: { query: "needle-token" } }
          : undefined;
      const reply = (text: string) => {
        if (anthropic) {
          send({ index: 0, delta: { type: "text_delta", text } }, "content_block_delta");
          send({ type: "message_stop" }, "message_stop");
          res.end();
        } else {
          send({ choices: [{ delta: { content: text } }] });
          res.end("data: [DONE]\n\n");
        }
      };
      if (call && firstRound) {
        if (anthropic) {
          send(
            { index: 0, content_block: { type: "tool_use", id: "call_1", name: call.name, input: {} } },
            "content_block_start",
          );
          send(
            { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } },
            "content_block_delta",
          );
          send({ type: "message_stop" }, "message_stop");
          res.end();
        } else {
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: call.name, arguments: JSON.stringify(call.args) } },
                  ],
                },
              },
            ],
          });
          res.end("data: [DONE]\n\n");
        }
        return;
      }
      reply(call ? `Answer after ${call.name}` : `Answer ${bodies.length}`);
    });
  });
  return { bodies, server };
}

describe("owner chat threads and project access", () => {
  let dirs: TempDirs, core: CrotCore, chat: ChatRuntime, server: http.Server, bodies: Body[];
  const audit = new MemoryAuditSink(),
    ui = new TestProvider();
  let projectTools = true;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    await mkdir(path.join(dirs.workspace, "src"));
    await mkdir(path.join(dirs.workspace, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(dirs.workspace, "README.md"), "# Demo\nThe readme-fixture-text.\n");
    await writeFile(path.join(dirs.workspace, "src", "app.ts"), "export const a = 1;\n// needle-token here\n");
    await writeFile(path.join(dirs.workspace, "node_modules", "dep", "index.js"), "needle-token in a dependency\n");
    await writeFile(path.join(dirs.workspace, ".env"), "needle-token=secret-env-value\n");
    ({ bodies, server } = fixture());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: { network: { allow: [`127.0.0.1:${port}`] }, approvals: { untrustedContent: "off" } },
      },
      audit,
      { approvalProviders: [ui] },
    );
    chat = new ChatRuntime({
      core: () => core,
      context: () => testContext,
      configuration: (provider) =>
        provider === "Anthropic"
          ? { endpoint: `http://127.0.0.1:${port}/anthropic/v1` }
          : { endpoint: `http://127.0.0.1:${port}/v1` },
      credential: (provider) => (provider === "Anthropic" ? "fixture-key" : undefined),
      run: (ctx, work) => work(ctx),
      project: () => (projectTools ? { name: "demo-project", root: dirs.workspace } : undefined),
    });
  });
  afterEach(async () => {
    await chat.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await core.shutdown();
    await dirs.cleanup();
  });
  const turn = async (message: string, extra: Record<string, unknown> = {}, provider = "Local HTTP") => {
    const started = chat.start({ provider, model: "fixture", message, ...extra }) as {
      id: string;
      thread: string;
      threadReset?: boolean;
    };
    await waitFor(() => chat.poll(started.id).state !== "running");
    return {
      ...started,
      result: chat.poll(started.id) as { state: string; blocks: { type: string; text: string; status?: string }[] },
    };
  };

  it("sends the project context and read-only project tools, and runs them through Core", async () => {
    const first = await turn("read-readme please");
    expect(first.result.state).toBe("completed");
    const [request, followUp] = bodies;
    expect(request!.messages[0]!.role).toBe("system");
    const system = String(request!.messages[0]!.content);
    expect(system).toContain('"demo-project"');
    expect(system).toContain(dirs.workspace);
    expect(system).toContain("README.md");
    expect(system).toContain("src/");
    expect(system).not.toContain(".env");
    expect(system).toContain("project_search_files");
    expect(toolNames(request!)).toEqual(["fs_read_file", "fs_list_directory", "fs_stat", "project_search_files"]);
    // The tool ran in Core (audited) and its result went back to the model.
    const toolMessage = followUp!.messages.find((m) => m.role === "tool")!;
    expect(String(toolMessage.content)).toContain("readme-fixture-text");
    expect(first.result.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool", name: "fs_read_file", status: "completed" })]),
    );
    expect(audit.events.some((e) => (e as { operation?: string }).operation === "filesystem.read_file")).toBe(true);
    expect(ui.shown).toHaveLength(0);

    const search = await turn("search-needle");
    expect(search.result.state).toBe("completed");
    const found = String(bodies.at(-1)!.messages.find((m) => m.role === "tool")!.content);
    expect(found).toContain("src/app.ts");
    expect(found).not.toContain("node_modules");
    expect(found).not.toContain("secret-env-value");
  });

  it("remembers earlier turns per thread, starts fresh threads and forgets a reset thread", async () => {
    const one = await turn("first question");
    expect(one.thread).toMatch(/^[0-9a-f-]{36}$/);
    const two = await turn("second question", { thread: one.thread });
    expect(two.thread).toBe(one.thread);
    expect(bodies[1]!.messages.map((m) => [m.role, m.content])).toEqual([
      ["system", expect.any(String)],
      ["user", "first question"],
      ["assistant", "Answer 1"],
      ["user", [{ type: "text", text: "second question" }]],
    ]);
    expect(chat.currentThread).toBe(one.thread);
    // No thread: a new conversation without history.
    const fresh = await turn("unrelated");
    expect(fresh.thread).not.toBe(one.thread);
    expect(bodies[2]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    // Reset: the thread is forgotten and a later turn on it reports the reset.
    expect(chat.reset(one.thread)).toEqual({ ok: true });
    const after = await turn("after reset", { thread: one.thread });
    expect(after.threadReset).toBe(true);
    expect(after.thread).not.toBe(one.thread);
    expect(bodies[3]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    // "New chat" forgets the latest thread: no current turn is restored and its turns are gone.
    expect(chat.current).toBe(after.id);
    expect(chat.reset()).toEqual({ ok: true });
    expect(chat.current).toBeUndefined();
    expect(chat.currentThread).toBeUndefined();
    expect(() => chat.poll(after.id)).toThrow(/Unknown conversation/);
  });

  it("keeps the system prompt and the first exchange while later turns slide out of a long thread", async () => {
    let thread: string | undefined;
    for (let i = 0; i < 22; i++) {
      const next = await turn(`turn ${i}`, thread ? { thread } : {});
      expect(next.result.state).toBe("completed");
      thread = next.thread;
    }
    const last = bodies.at(-1)!.messages;
    // System prompt + the first exchange (the goal) + the 19 latest exchanges + the new message.
    expect(last).toHaveLength(42);
    expect(last[0]!.role).toBe("system");
    expect(last.slice(1, 5).map((m) => m.content)).toEqual(["turn 0", "Answer 1", "turn 2", "Answer 3"]);
    expect(last.slice(-3, -1).map((m) => m.content)).toEqual(["turn 20", "Answer 21"]);
    expect(last.at(-1)!.content).toEqual([{ type: "text", text: "turn 21" }]);
    expect(last.some((m) => m.content === "turn 1")).toBe(false);
  });

  it("bounds a thread by size and keeps its first exchange", async () => {
    const big = (i: number) => `${i}:${"x".repeat(30_000)}`;
    let thread: string | undefined;
    for (let i = 0; i < 5; i++) thread = (await turn(big(i), thread ? { thread } : {})).thread;
    // Four 30 000-character turns exceed the 120 000-character history: the second exchange went.
    expect(
      bodies
        .at(-1)!
        .messages.slice(1, -1)
        .map((m) => String(m.content).split(":")[0]),
    ).toEqual(["0", "Answer 1", "2", "Answer 3", "3", "Answer 4"]);
  });

  it("forgets the least recently used thread beyond the thread count", async () => {
    const first = await turn("keep me");
    const second = await turn("drop me");
    for (let i = 0; i < 14; i++) await turn(`filler ${i}`);
    await turn("touch", { thread: first.thread });
    await turn("one more");
    // 17 threads: the least recently used one (not the first, touched again) is forgotten.
    expect((await turn("again", { thread: second.thread })).threadReset).toBe(true);
    const kept = await turn("still here", { thread: first.thread });
    expect(kept.threadReset).toBeUndefined();
    expect(kept.thread).toBe(first.thread);
  });

  it("forgets the least recently used threads beyond the total remembered size", async () => {
    // Twelve threads of three 30 000-character turns exceed the 1 000 000 characters kept in total.
    const threads: string[] = [];
    for (let t = 0; t < 12; t++) {
      let thread: string | undefined;
      for (let i = 0; i < 3; i++)
        thread = (await turn(`${t}.${i}:${"y".repeat(30_000)}`, thread ? { thread } : {})).thread;
      threads.push(thread!);
    }
    expect((await turn("lost", { thread: threads[0] })).threadReset).toBe(true);
    const remembered = await turn("remembered", { thread: threads[1] });
    expect(remembered.threadReset).toBeUndefined();
    expect(bodies.at(-1)!.messages).toHaveLength(8);
  });

  it("uses the Anthropic system parameter and history", async () => {
    const one = await turn("hello", {}, "Anthropic");
    await turn("again", { thread: one.thread }, "Anthropic");
    const [first, second] = bodies;
    expect(first!.system).toContain('"demo-project"');
    expect(first!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(second!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second!.messages[1]!.content).toBe("Answer 1");
    expect(toolNames(second!)).toContain("fs_read_file");
  });

  it("retries once without the automatic tools when the server rejects tool definitions", async () => {
    const result = await turn("reject-tools hello");
    expect(result.result.state).toBe("completed");
    expect(bodies).toHaveLength(2);
    expect(toolNames(bodies[0]!)).toHaveLength(4);
    expect(bodies[1]!.tools).toBeUndefined();
    expect(String(bodies[1]!.messages[0]!.content)).toContain("File tools are not available");
    expect(result.result.blocks.filter((b) => b.type === "assistant")).toEqual([
      expect.objectContaining({ text: "Answer 2" }),
    ]);
    // A tool the owner selected is not dropped silently: the rejection fails the turn.
    const selected = await turn("reject-tools again", { tools: ["fs_write_file"] });
    expect(selected.result.state).toBe("failed");
  });

  it("sends no project tools when they are turned off or no project is open", async () => {
    await turn("plain", { projectTools: false });
    expect(bodies[0]!.tools).toBeUndefined();
    expect(String(bodies[0]!.messages[0]!.content)).toContain("File tools are not available");
    projectTools = false;
    await turn("no project");
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("never raises an approval for the project prompt when listing needs approval", async () => {
    core.permissions.runtime.replace({
      strict: false,
      rules: [{ operation: "filesystem.list_directory", state: "ask" }],
    });
    const result = await turn("hello");
    expect(result.result.state).toBe("completed");
    expect(String(bodies[0]!.messages[0]!.content)).not.toContain("Top-level entries");
    expect(ui.shown).toHaveLength(0);
  });
});

describe("custom provider profile names", () => {
  it("derives slugs and labels from the endpoint host", () => {
    expect(customSlug("https://api.river.ai/v1")).toBe("river");
    expect(customLabel("https://api.river.ai/v1")).toBe("River");
    expect(customSlug("http://127.0.0.1:8080/v1")).toBe("127-0-0-1-8080");
    expect(customLabel("http://127.0.0.1:8080/v1")).toBe("127.0.0.1:8080");
    expect(customSlug("https://llm.example.com:8443")).toBe("llm-8443");
    expect(customSlug("not a url")).toBe("custom");
  });
});
