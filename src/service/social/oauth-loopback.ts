/** Native-app OAuth front channel. No webview, no callback code/token in logs or renderer events. */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export interface OAuthLoopbackOptions {
  authorizationEndpoint: string;
  clientId: string;
  clientParameter?: "client_id" | "client_key";
  scopes: readonly string[];
  scopeSeparator?: " " | ",";
  challengeEncoding?: "base64url" | "hex";
  extra?: Readonly<Record<string, string>>;
  /** Trusted owner/system-browser boundary, not caller-controlled executable/command. */
  openBrowser(url: string): Promise<void>;
  exchange(input: { code: string; verifier: string; redirectUri: string; signal: AbortSignal }): Promise<void>;
  /** Trusted fixture host only. Production callers must never accept endpoints from agents/renderer. */
  allowLoopbackFixture?: boolean;
  timeoutMs?: number;
}
export interface OAuthFlow {
  readonly id: string;
  readonly completion: Promise<void>;
  cancel(): Promise<void>;
}
const secret = () => randomBytes(32).toString("base64url");
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
export async function startOAuthLoopback(options: OAuthLoopbackOptions): Promise<OAuthFlow> {
  const endpoint = new URL(options.authorizationEndpoint);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (options.allowLoopbackFixture === true && endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")
    )
  )
    throw new Error("Invalid OAuth authorization endpoint");
  if (!options.clientId || options.clientId.length > 512) throw new Error("Invalid OAuth client ID");
  const state = secret(),
    verifier = secret(),
    id = secret(),
    route = "/oauth/callback/" + secret(),
    controller = new AbortController();
  let settled = false,
    resolve!: () => void,
    reject!: (e: Error) => void;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Cancellation is observable by the caller but never becomes an unhandled rejection before it attaches.
  void completion.catch(() => undefined);
  const server = createServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  const finish = async (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    controller.abort();
    server.closeIdleConnections();
    await close(server);
    if (error) reject(error);
    else resolve();
  };
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", no);
      yes();
    });
  });
  const port = (server.address() as { port: number }).port,
    host = `127.0.0.1:${port}`,
    redirectUri = `http://${host}${route}`;
  server.on("request", (req, res) => {
    const send = (code: number, text: string) => {
      res.writeHead(code, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      res.end(text);
    };
    if (
      req.method !== "GET" ||
      req.headers.host !== host ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.origin ||
      !req.url ||
      req.url.length > 8192
    ) {
      send(400, "Invalid OAuth callback");
      return;
    }
    const url = new URL(req.url, redirectUri),
      values = url.searchParams;
    if (url.pathname !== route) {
      send(404, "Not found");
      return;
    }
    if (
      settled ||
      values.getAll("state").length !== 1 ||
      values.getAll("code").length > 1 ||
      values.getAll("error").length > 1
    ) {
      send(400, "Invalid OAuth callback");
      return;
    }
    const received = Buffer.from(values.get("state") ?? ""),
      expected = Buffer.from(state);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      send(400, "Invalid OAuth state");
      return;
    }
    if (values.has("error")) {
      send(400, "Authorization was not completed. Return to CROT.");
      void finish(new Error("OAuth authorization denied"));
      return;
    }
    const code = values.get("code");
    if (!code || code.length > 4096 || /[\r\n\0]/.test(code)) {
      send(400, "Invalid OAuth authorization code");
      return;
    }
    // Atomically consume before the first async exchange; a duplicate callback cannot redeem twice.
    settled = true;
    clearTimeout(timer);
    send(200, "Authorization received. Return to CROT. This window can be closed.");
    void (async () => {
      try {
        await options.exchange({ code, verifier, redirectUri, signal: controller.signal });
        resolve();
      } catch {
        reject(new Error("OAuth exchange or system secret storage failed"));
      } finally {
        controller.abort();
        server.closeIdleConnections();
        await close(server);
      }
    })();
  });
  const timer = setTimeout(() => void finish(new Error("OAuth authorization timed out")), options.timeoutMs ?? 300_000);
  timer.unref();
  const authorization = new URL(endpoint);
  const reserved = new Set([
    "client_id",
    "client_key",
    "redirect_uri",
    "response_type",
    "state",
    "code_challenge",
    "code_challenge_method",
    "scope",
  ]);
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (reserved.has(key)) {
      await finish(new Error("Invalid OAuth provider parameters"));
      throw new Error("Reserved OAuth parameter");
    }
    authorization.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries({
    [options.clientParameter ?? "client_id"]: options.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: createHash("sha256")
      .update(verifier)
      .digest(options.challengeEncoding ?? "base64url"),
    code_challenge_method: "S256",
    scope: options.scopes.join(options.scopeSeparator ?? " "),
  }))
    authorization.searchParams.set(key, value);
  try {
    await options.openBrowser(authorization.href);
  } catch {
    await finish(new Error("System browser could not be opened"));
    throw new Error("System browser could not be opened");
  }
  return {
    id,
    completion,
    cancel: async () => {
      controller.abort();
      server.closeAllConnections();
      if (settled) {
        server.closeAllConnections();
        await close(server);
      } else await finish(new Error("OAuth authorization cancelled"));
    },
  };
}
