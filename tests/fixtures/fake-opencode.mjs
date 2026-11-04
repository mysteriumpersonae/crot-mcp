// A stand-in for `opencode serve` (tests of the local OpenCode bridge): the routes CROT uses, HTTP Basic auth
// with OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD, and a free-tier-limit mode that keeps retrying.
// FAKE_OPENCODE_LOG: a file that gets one JSON line per request; FAKE_OPENCODE_MODE_FILE: a file holding the
// mode ("ok" or "limit"), read at every message. Like OpenCode 1.19.5, a message for a model it does not list
// fails with HTTP 500 (UnknownError), and the free tier limit is a retry status with OpenCode's Go link.
// CROT's text tool protocol (chat-tool-protocol.ts): a new message "READ:<path>" is answered with an
// fs_read_file call, "CALL:<tool>" with a call of that tool, and a message of tool results with a final answer
// that quotes them.
import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import process from "node:process";
import { URL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] !== "serve" || option("--hostname") !== "127.0.0.1") process.exit(2);
const port = Number(option("--port"));
const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const mode = () => {
  try {
    return readFileSync(process.env.FAKE_OPENCODE_MODE_FILE ?? "", "utf8").trim() || "ok";
  } catch {
    return "ok";
  }
};
const record = (entry) => {
  if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(entry)}\n`);
};
const statuses = {};
const pending = new Map();
let sessions = 0;

const model = (id, name, input, output) => ({ id, providerID: "opencode", name, cost: { input, output } });
const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      models: {
        "big-pickle": model("big-pickle", "Big Pickle", 0, 0),
        "glm-5.3-flash-free": model("glm-5.3-flash-free", "GLM-5.3-Flash Free", 0, 0),
      },
    },
    { id: "local-only", name: "Not connected", models: { x: model("x", "X", 0, 0) } },
  ],
  connected: ["opencode"],
  default: { opencode: "big-pickle" },
};

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const expected = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;
    if (expected && req.headers.authorization !== expected) return send(res, 401, { error: "unauthorized" });
    const url = new URL(req.url, "http://127.0.0.1");
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    const directory = req.headers["x-opencode-directory"];
    if (url.pathname !== "/global/health" && url.pathname !== "/session/status")
      record({
        method: req.method,
        path: url.pathname,
        ...(typeof directory === "string" ? { directory: decodeURIComponent(directory) } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    if (req.method === "GET" && url.pathname === "/global/health")
      return send(res, 200, { healthy: true, version: "0.0.0-fake" });
    if (req.method === "GET" && url.pathname === "/provider") return send(res, 200, provider);
    if (req.method === "GET" && url.pathname === "/session/status") return send(res, 200, statuses);
    if (req.method === "POST" && url.pathname === "/session") return send(res, 200, { id: `ses_${++sessions}` });
    const match = /^\/session\/(ses_\d+)(\/message|\/abort)?$/.exec(url.pathname);
    if (!match) return send(res, 404, { error: "not found" });
    const [, id, action] = match;
    if (req.method === "DELETE" && !action) {
      delete statuses[id];
      return send(res, 200, true);
    }
    if (req.method === "POST" && action === "/abort") {
      delete statuses[id];
      const answer = pending.get(id);
      pending.delete(id);
      answer?.({
        info: { id: "msg_1", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
        parts: [],
      });
      return send(res, 200, true);
    }
    if (req.method === "POST" && action === "/message") {
      const known = provider.all.find((p) => p.id === body?.model?.providerID)?.models[body?.model?.modelID];
      if (!known)
        return send(res, 500, {
          name: "UnknownError",
          data: { message: "Unexpected server error. Check server logs for details.", ref: "err_fake1" },
        });
      if (mode() === "limit") {
        statuses[id] = {
          type: "retry",
          attempt: 1,
          message: "Free usage exceeded, subscribe to Go",
          action: {
            reason: "free_tier_limit",
            title: "Free limit reached",
            message: "Subscribe to OpenCode Go for reliable access to the best open-source models.",
            link: "https://opencode.ai/go",
          },
          next: Date.now() + 3_600_000,
        };
        pending.set(id, (value) => send(res, 200, value));
        return;
      }
      const text = body?.parts?.[0]?.text ?? "";
      const answer = (reply) =>
        send(res, 200, { info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: reply }] });
      // Only the new message counts, not the earlier turns CROT sends along.
      const latest = text.slice(text.lastIndexOf("New message:\n") + 1);
      const call = (tool, args) =>
        answer(`Using ${tool}.\n\`\`\`crot-tool\n${JSON.stringify({ tool, arguments: args })}\n\`\`\``);
      if (text.startsWith("```crot-tool-result")) return answer(`Final answer from the tool results:\n${text}`);
      const read = /^READ:(\S+)/m.exec(latest)?.[1];
      if (read) return call("fs_read_file", { path: read });
      const tool = /^CALL:(\S+)/m.exec(latest)?.[1];
      if (tool) return call(tool, {});
      return answer(`Local answer from ${body?.model?.modelID} (${text.length} chars)`);
    }
    return send(res, 404, { error: "not found" });
  });
});
server.listen(port, "127.0.0.1");
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
