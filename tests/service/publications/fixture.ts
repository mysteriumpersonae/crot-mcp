/** Actual CrotService, authenticated owner and MCP connections, local OAuth/upload HTTP.
 * The explicit memory secret/entitlement seams are protocol evidence, NOT native store or commercial qualification. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CrotService } from "../../../src/service/service.js";
import { ControlClient } from "../../../src/service/control-client.js";
import { connectChannel, MAX_SERVER_FRAME_BYTES, type AuthenticatedChannel } from "../../../src/service/channel.js";
import { secretCredentialStore, serviceEndpoint } from "../../../src/service/endpoints.js";
import { configDigest } from "../../../src/service/config-digest.js";
import { parseServiceMessage, SERVICE_PROTOCOL_VERSION } from "../../../src/service/protocol.js";
import { AccountSecrets } from "../../../src/service/social/account-secrets.js";
import { fixtureOAuthAdapter } from "../../../src/service/social/provider-http.js";
import { fixturePublisher } from "../../../src/service/publications/platforms.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import type { SocialAccount } from "../../../src/service/social/accounts.js";
import type { PublicationRecord } from "../../../src/core/publications/service.js";
import type { ServeCommand } from "../../../src/cli/options.js";
import type { ProductMethod } from "../../../src/service/product-protocol.js";
import { makeTempDirs, waitFor } from "../../helpers.js";
class AgentTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly channel: AuthenticatedChannel) {
    channel.onmessage = (value) => {
      const message = parseServiceMessage(value);
      if (message?.t === "mcp") this.onmessage?.(JSON.parse(message.data) as JSONRPCMessage);
    };
    channel.onclose = () => this.onclose?.();
    channel.start();
  }
  async start() {}
  async send(message: JSONRPCMessage) {
    this.channel.send({ t: "mcp", line: JSON.stringify(message) });
  }
  async close() {
    this.channel.close();
  }
}
export const fixtureImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=",
  "base64",
);
export async function ownerRequest<T>(
  owner: ControlClient,
  method: ProductMethod,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (await owner.request(method, params)) as T;
}
export async function publicationFixture(options: { productionGate?: boolean } = {}) {
  const dirs = await makeTempDirs(),
    stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-p-")));
  const privateFiles = createPrivateFileProtection(process.platform === "win32"),
    values = new Map<string, string>();
  let authorization: URL | undefined,
    writes = 0,
    revoked = 0,
    allow = true,
    hold = false;
  const uploads: Buffer[] = [];
  const waiting: ServerResponse[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url!, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/authorize") {
        authorization = u;
        const callback = new URL(u.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", u.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-code");
        res.writeHead(302, { location: callback.href }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (u.pathname === "/token") {
        const form = new URLSearchParams(body.toString());
        if (
          !form.get("code_verifier") ||
          createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !==
            authorization?.searchParams.get("code_challenge")
        ) {
          res.writeHead(400).end("{}");
          return;
        }
        res.end(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh" }));
        return;
      }
      if (u.pathname === "/revoke") {
        revoked++;
        res.end("{}");
        return;
      }
      if (req.headers.authorization !== "Bearer fixture-access") {
        res.writeHead(401).end("{}");
        return;
      }
      if (u.pathname === "/profile") {
        res.end(JSON.stringify({ data: { id: "recipient", username: "fixture", name: "Fixture Owner" } }));
        return;
      }
      if (u.pathname === "/2/users/me") {
        res.end(JSON.stringify({ data: { id: "recipient", protected: false } }));
        return;
      }
      if (u.pathname === "/2/media/upload") {
        uploads.push(body);
        res.end(JSON.stringify({ data: { id: "media-1" } }));
        return;
      }
      if (u.pathname === "/2/tweets") {
        writes++;
        if (!hold) res.end(JSON.stringify({ data: { id: "post-1" } }));
        else waiting.push(res);
        return;
      }
      res.writeHead(404).end("{}");
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("{}");
    });
  });
  let service: CrotService | undefined, owner: ControlClient | undefined, agent: Client | undefined;
  const owners: ControlClient[] = [];
  const close = async () => {
    for (const connection of owners) connection.close();
    await agent?.close();
    await service?.shutdown("publication fixture cleanup");
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await rm(stateDir, { recursive: true, force: true });
    await dirs.cleanup();
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const secrets = new AccountSecrets({
      kind: "secret-service",
      get: async (p, f) => values.get(p + f),
      set: async (p, f, value) => {
        values.set(p + f, value);
      },
      delete: async (p, f) => {
        values.delete(p + f);
      },
    });
    const command: ServeCommand = {
      kind: "serve",
      warnings: [],
      config: {
        workspace: { root: dirs.workspace },
        environment: { path: "inherited" },
        permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
        secrets: { store: "file" },
        audit: { sink: "file", path: path.join(stateDir, "audit.jsonl") },
      },
    };
    const started = await CrotService.start({
      command,
      stateDir,
      privateFiles,
      launch: "managed",
      log: () => {},
      requestStop: () => {},
      socialAccounts: {
        secrets: async () => secrets,
        adapters: new Map([["x", fixtureOAuthAdapter("x", origin)]]),
        loopbackFixtures: true,
      },
      ...(!options.productionGate
        ? {
            publicationFixture: {
              publisher: fixturePublisher(origin),
              authorizePublication: async () => {
                if (!allow) throw new Error("Fixture entitlement revoked");
              },
            },
          }
        : {}),
    });
    if (started === "already_running") throw new Error("Unexpected running service");
    service = started;
    const newOwner = async () => {
      const connected = await ControlClient.connect({ stateDir, privateFiles });
      if (!connected) throw new Error("Owner channel unavailable");
      owners.push(connected);
      return connected;
    };
    owner = await newOwner();
    await owner.request("accounts.configure", { provider: "x", clientId: "fixture-client" });
    const flow = await ownerRequest<{ authorizationUrl: string }>(owner, "accounts.connect", { provider: "x" });
    await fetch(flow.authorizationUrl);
    await waitFor(async () =>
      (await ownerRequest<{ accounts: SocialAccount[] }>(owner!, "accounts.list")).accounts.some(
        (account) => account.state === "connected",
      ),
    );
    await writeFile(path.join(dirs.workspace, "image.png"), fixtureImage);
    const credential = await secretCredentialStore(stateDir, privateFiles).read("service");
    if (!credential) throw new Error("Agent credential unavailable");
    const channel = await connectChannel(serviceEndpoint(stateDir, "service", credential).path, {
      channel: "service",
      credential,
      maxFrameBytes: MAX_SERVER_FRAME_BYTES,
    });
    await new Promise<void>((resolve, reject) => {
      channel.onmessage = (value) => {
        channel.pause();
        if (parseServiceMessage(value)?.t === "welcome") resolve();
        else reject(new Error("Agent handshake refused"));
      };
      channel.onclose = () => reject(new Error("Agent channel closed"));
      channel.start();
      channel.send({
        t: "hello",
        version: SERVICE_PROTOCOL_VERSION,
        configDigest: configDigest("", command.config),
        pid: process.pid,
      });
    });
    agent = new Client({ name: "publication-fixture-agent", version: "1" });
    await agent.connect(new AgentTransport(channel));
    const prepare = async (mediaPath: string | undefined = "image.png") => {
      const result = await agent!.callTool({
        name: "publication_prepare",
        arguments: {
          provider: "x",
          accountId: "x:recipient",
          title: "Title",
          description: "Description",
          ...(mediaPath ? { mediaPath } : {}),
        },
      });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as PublicationRecord;
    };
    return {
      dirs,
      stateDir,
      service,
      owner,
      agent,
      newOwner,
      prepare,
      close,
      values,
      uploads,
      writes: () => writes,
      revoked: () => revoked,
      hold: (value: boolean) => {
        hold = value;
        if (!value)
          for (const response of waiting.splice(0))
            if (!response.destroyed) response.end(JSON.stringify({ data: { id: "post-1" } }));
      },
      allow: (value: boolean) => {
        allow = value;
      },
      audit: () => readFile(path.join(stateDir, "audit.jsonl"), "utf8"),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
