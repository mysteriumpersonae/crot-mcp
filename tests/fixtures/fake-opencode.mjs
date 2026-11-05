// A stand-in for `opencode serve` (tests of the local OpenCode bridge): the routes CROT uses, HTTP Basic auth
// with OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD, and a free-tier-limit mode that keeps retrying.
// FAKE_OPENCODE_LOG: a file that gets one JSON line per request; FAKE_OPENCODE_MODE_FILE: a file holding the
// mode ("ok" or "limit"), read at every message. Like OpenCode 1.19.5, a message for a model it does not list
// fails with HTTP 500 (UnknownError), and the free tier limit is a retry status with OpenCode's Go link.
// CROT's text tool protocol (chat-tool-protocol.ts): a new message "READ:<path>" is answered with an
// fs_read_file call, "CALL:<tool>" with a call of that tool, and a message of tool results with a final answer
// that quotes them.
// Leading flags play OpenCode installations that do not start: --fake-old (OpenCode 0.x: no /global/health,
// `--version` 0.15.31), --fake-crash (an npm installation without its postinstall script: an error, exit 1),
// --fake-unhealthy (answers /global/health with 503 and logs an error). `--version` prints FAKE_OPENCODE_VERSION
// (default 1.19.5); FAKE_OPENCODE_STARTS: a file that gets one JSON line per start (flags, XDG folders, the
// first PATH entry).
// --fake-v2 plays OpenCode 2.2.5 (new server API): its web app answers /global/health and every other unknown GET
// with a page (even without the password), POSTs of OpenCode 1.x with 405; /api/info, /api/model and the stateless
// /api/experimental/generate/text need the password. In "limit" mode a generation fails as OpenCode 2 does when
// Zen refuses a free model (HTTP 502 ProviderRequestError with the provider's 429); the tool protocol answers the
// latest "New message:" of the prompt.
import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

const args = process.argv.slice(2);
const flags = [];
while (args[0]?.startsWith("--fake-")) flags.push(args.shift());
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const v2 = flags.includes("--fake-v2");
if (args[0] === "--version") {
  const version = flags.includes("--fake-old")
    ? "0.15.31"
    : process.env.FAKE_OPENCODE_VERSION || (v2 ? "2.2.5" : "1.19.5");
  process.stdout.write(v2 ? `opencode v${version}\n` : `${version}\n`);
  process.exit(0);
}
if (args[0] !== "serve" || option("--hostname") !== "127.0.0.1") process.exit(2);
if (process.env.FAKE_OPENCODE_STARTS)
  appendFileSync(
    process.env.FAKE_OPENCODE_STARTS,
    `${JSON.stringify({
      flags,
      xdg: Object.fromEntries(
        ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((n) => [
          n,
          process.env[n] ?? null,
        ]),
      ),
      path: (process.env.PATH ?? "").split(path.delimiter)[0],
    })}\n`,
  );
if (flags.includes("--fake-crash")) {
  process.stderr.write("Error: opencode-ai's postinstall script was not run.\n");
  process.exit(1);
}
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
const PAGE = '<!doctype html>\n<html lang="en"><head><title>OpenCode</title></head><body></body></html>';
const v2Model = (id, name, price, enabled = true, providerID = "opencode") => ({
  id,
  modelID: id,
  providerID,
  type: "chat",
  name,
  cost: [{ input: price, output: price, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled,
});
// Signed out: the free models; the paid one is listed but disabled, another provider's model is not Zen's.
const v2Models = [
  v2Model("big-pickle", "Big Pickle", 0),
  v2Model("glm-5.3-flash-free", "GLM-5.3-Flash Free", 0),
  v2Model("kimi-k2.6", "Kimi K2.6", 1, false),
  v2Model("big-pickle", "Big Pickle", 0, true, "opencode-go"),
];
const FREE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";
/** OpenCode 2.2.5: the web app's page, /api/info, /api/model and the stateless text generation. */
function v2Request(req, res, url, raw) {
  const page = () => res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  if (!url.pathname.startsWith("/api/")) {
    if (req.method === "GET") return page();
    return res.writeHead(405).end();
  }
  const expected = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
  if (expected && req.headers.authorization !== expected)
    return send(res, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
  let body;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return send(res, 400, { _tag: "InvalidRequestError", message: "Invalid JSON" });
  }
  record({ method: req.method, path: url.pathname, ...(body !== undefined ? { body } : {}) });
  if (req.method === "GET" && url.pathname === "/api/info")
    return send(res, 200, {
      version: process.env.FAKE_OPENCODE_VERSION || "2.2.5",
      pid: process.pid,
      hostname: null,
      urls: [`http://127.0.0.1:${port}`],
      paths: { tmp: "/tmp" },
    });
  if (req.method === "GET" && url.pathname === "/api/model")
    return send(res, 200, { location: { directory: process.cwd() }, data: v2Models });
  if (req.method === "POST" && url.pathname === "/api/experimental/generate/text") {
    const extra = Object.keys(body ?? {}).filter((k) => k !== "prompt" && k !== "model");
    if (typeof body?.prompt !== "string" || extra.length)
      return send(res, 400, { _tag: "InvalidRequestError", message: `Invalid request: ${extra.join(", ")}` });
    const ref = body.model ?? {};
    const known = v2Models.find((m) => m.providerID === ref.providerID && m.id === ref.id && m.enabled);
    if (!known)
      return send(res, 404, {
        _tag: "ModelNotFoundError",
        providerID: String(ref.providerID),
        modelID: String(ref.id),
        message: `Model not found: ${ref.providerID}/${ref.id}`,
      });
    if (mode() === "limit")
      return send(res, 502, {
        _tag: "ProviderRequestError",
        providerID: "opencode",
        reason: "rate_limit",
        message: FREE_LIMIT,
        status: 429,
        retryAfterMs: 15_952_000,
      });
    const answer = (text) => send(res, 200, { data: { text } });
    // Only the new message counts, not the instructions and the conversation CROT sends along.
    const marker = "New message:\n",
      latest = body.prompt.includes(marker)
        ? body.prompt.slice(body.prompt.lastIndexOf(marker) + marker.length)
        : body.prompt;
    const call = (tool, args) =>
      answer(`Using ${tool}.\n\`\`\`crot-tool\n${JSON.stringify({ tool, arguments: args })}\n\`\`\``);
    if (latest.startsWith("```crot-tool-result")) return answer(`Final answer from the tool results:\n${latest}`);
    const read = /^READ:(\S+)/m.exec(latest)?.[1];
    if (read) return call("fs_read_file", { path: read });
    const tool = /^CALL:(\S+)/m.exec(latest)?.[1];
    if (tool) return call(tool, {});
    return answer(`Local answer from ${ref.id} via OpenCode 2 (${body.prompt.length} chars)`);
  }
  return send(res, 404, { _tag: "NotFound", message: "Not found" });
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (v2) return v2Request(req, res, new URL(req.url, "http://127.0.0.1"), Buffer.concat(chunks).toString("utf8"));
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
    if (req.method === "GET" && url.pathname === "/global/health") {
      if (flags.includes("--fake-old")) return send(res, 404, { error: "not found" });
      if (flags.includes("--fake-unhealthy")) {
        process.stderr.write("Error: database is locked\n");
        return send(res, 503, { healthy: false });
      }
      return send(res, 200, { healthy: true, version: "0.0.0-fake" });
    }
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
