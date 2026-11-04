/**
 * OAuth grants of the self-registered relay URL (src/service/oauth-grants.ts): access and rotating refresh
 * tokens bound to a client token, and the device's token endpoint.
 */
import { createServer, request, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { principalFromAuthInfo } from "../../src/adapters/http/context.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { generateDeviceId } from "../../src/identity/device-id.js";
import { ClientTokenRegistry, clientTokenPath } from "../../src/service/client-tokens.js";
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  OAuthGrants,
  OAuthTokenEndpoint,
  oauthGrantPath,
  REFRESH_TOKEN_PREFIX,
} from "../../src/service/oauth-grants.js";
import { makeTempDirs, type TempDirs } from "../helpers.js";

let time = Date.now();
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

async function setup() {
  const dirs: TempDirs = await makeTempDirs();
  cleanup.push(() => dirs.cleanup());
  // Whole seconds: AuthInfo.expiresAt (the client token's expiry) is in seconds.
  time = Math.floor(Date.now() / 1000) * 1000;
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const tokens = await ClientTokenRegistry.open({
    file: clientTokenPath(dirs.outside),
    privateFiles,
    audit: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
    failClosed: vi.fn(),
    clock: () => time,
  });
  cleanup.push(() => tokens.close());
  const file = oauthGrantPath(dirs.outside);
  const open = async () => {
    const grants = await OAuthGrants.open({ file, privateFiles, parents: tokens, clock: () => time });
    cleanup.push(() => grants.close());
    return grants;
  };
  const issue = async (ttlSeconds = 3600, scopes = ["files"]) => {
    const issued = await tokens.issue({ name: "client", ttlSeconds, scopes });
    return { id: String(issued.id), token: String(issued.token) };
  };
  const parentOf = async (token: string) => OAuthGrants.parentOf(await tokens.verifyAccessToken(token))!;
  return { tokens, file, open, issue, parentOf };
}

describe("OAuthGrants", () => {
  it("mints access and refresh tokens that authenticate exactly as their client token; only digests persist", async () => {
    const { tokens, file, open, issue, parentOf } = await setup();
    const grants = await open();
    const client = await issue();
    const parent = await parentOf(client.token);
    expect(parent).toMatchObject({ id: client.id, scopes: ["files"] });
    const granted = await grants.issue(parent, "mcp");
    expect(granted).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(granted.access_token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(granted.refresh_token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect((await grants.issue(parent)).scope).toBe("files");
    const info = (await grants.verifyAccessToken(granted.access_token))!;
    const direct = (await tokens.verifyAccessToken(client.token))!;
    expect(info.clientId).toBe(direct.clientId);
    expect(info.scopes).toEqual(["files"]);
    expect(info.extra).toEqual(direct.extra);
    const principal = principalFromAuthInfo("loopback", info)!;
    expect(principal.tokenAccess).toMatchObject({ id: client.id, scopes: ["files"] });
    expect(() => tokens.authorize(principal)).not.toThrow();
    // An access token is never a client secret, and a client token is never an access token.
    expect(OAuthGrants.parentOf(info)).toBeUndefined();
    expect(OAuthGrants.parentOf(undefined)).toBeUndefined();
    expect(await grants.verifyAccessToken(client.token)).toBeUndefined();
    expect(await grants.verifyAccessToken(granted.refresh_token)).toBeUndefined();
    const stored = await readFile(file, "utf8");
    for (const secret of [granted.access_token, granted.refresh_token, client.token])
      expect(stored).not.toContain(secret);
    // Grants survive a restart.
    await grants.close();
    const reopened = await open();
    expect(reopened.size).toBe(2);
    expect(await reopened.verifyAccessToken(granted.access_token)).toBeDefined();
  });

  it("rotates refresh tokens, expires access tokens and ends grants with their client token", async () => {
    const { tokens, open, issue, parentOf } = await setup();
    const grants = await open();
    const client = await issue(7200);
    const parent = await parentOf(client.token);
    const first = await grants.issue(parent);
    const second = (await grants.refresh(parent, first.refresh_token))!;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await grants.refresh(parent, first.refresh_token)).toBeUndefined();
    expect(await grants.verifyAccessToken(first.access_token)).toBeUndefined();
    expect(await grants.verifyAccessToken(second.access_token)).toBeDefined();
    // A refresh token works only with the client secret it was granted to.
    const other = await parentOf((await issue(4 * 3600)).token);
    expect(await grants.refresh(other, second.refresh_token)).toBeUndefined();
    for (const bad of ["", "crot_rt_unknown", `${REFRESH_TOKEN_PREFIX}${"x".repeat(300)}`, second.access_token])
      expect(await grants.refresh(parent, bad)).toBeUndefined();
    // Access tokens live an hour; the refresh token still works.
    time += ACCESS_TOKEN_TTL_MS;
    expect(await grants.verifyAccessToken(second.access_token)).toBeUndefined();
    const third = (await grants.refresh(parent, second.refresh_token))!;
    expect(third.expires_in).toBe(3600);
    expect(await grants.verifyAccessToken(third.access_token)).toBeDefined();
    // Never past the client token: an hour remains.
    time += 30 * 60_000;
    const fourth = (await grants.refresh(parent, third.refresh_token))!;
    expect(fourth.expires_in).toBe(1800);
    // Rotating the client token ends the grant (access and refresh).
    await tokens.rotate(client.id);
    expect(await grants.verifyAccessToken(fourth.access_token)).toBeUndefined();
    expect(await grants.refresh(parent, fourth.refresh_token)).toBeUndefined();
    // Revoking ends every grant of that token; grants of other tokens are kept and stale ones pruned.
    const kept = await grants.issue(other);
    await tokens.revoke(other.id);
    expect(await grants.verifyAccessToken(kept.access_token)).toBeUndefined();
    const fresh = await parentOf((await issue()).token);
    await grants.issue(fresh);
    expect(grants.size).toBe(1);
  });
});

function post(port: number, body: string, headers: Record<string, string> = {}, method = "POST") {
  return new Promise<{ status: number; headers: Record<string, unknown>; json: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: "/oauth/token",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: JSON.parse(text) }));
        },
      );
      req.once("error", reject);
      req.end(body);
    },
  );
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

describe("OAuthTokenEndpoint", () => {
  it("serves client_credentials and refresh_token to the device's own OAuth client only", async () => {
    const { tokens, open, issue } = await setup();
    const grants = await open();
    const deviceId = generateDeviceId();
    let selfId: string | undefined = deviceId;
    const log: string[] = [];
    const endpoint = new OAuthTokenEndpoint({
      grants,
      parents: tokens,
      deviceId: () => selfId,
      log: (m) => log.push(m),
    });
    const server: Server = createServer((req, res) => void endpoint.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const client = await issue();
    const auth = { authorization: basic(`crot-${deviceId}`, client.token) };

    const granted = await post(port, "grant_type=client_credentials&scope=mcp", auth);
    expect(granted.status).toBe(200);
    expect(granted.headers["cache-control"]).toBe("no-store");
    expect(granted.json).toMatchObject({ token_type: "Bearer", scope: "mcp", expires_in: 3600 });
    expect(await grants.verifyAccessToken(String(granted.json.access_token))).toBeDefined();
    // client_secret_post with the bare device id.
    const posted = await post(
      port,
      `grant_type=client_credentials&client_id=${deviceId}&client_secret=${encodeURIComponent(client.token)}`,
    );
    expect(posted.status).toBe(200);
    const refreshed = await post(
      port,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(granted.json.refresh_token))}`,
      auth,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refresh_token).not.toBe(granted.json.refresh_token);
    const reused = await post(
      port,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(granted.json.refresh_token))}`,
      auth,
    );
    expect(reused).toMatchObject({ status: 400, json: { error: "invalid_grant" } });
    expect(await post(port, "grant_type=password&username=a&password=b", auth)).toMatchObject({
      status: 400,
      json: { error: "unsupported_grant_type" },
    });
    expect(await post(port, 'grant_type=client_credentials&scope=a"b', auth)).toMatchObject({
      status: 400,
      json: { error: "invalid_scope" },
    });

    // Client authentication.
    const unauthorized: Record<string, string>[] = [
      {},
      { authorization: basic(`crot-${generateDeviceId()}`, client.token) },
      { authorization: basic(`crot-${deviceId}`, "wrong-secret-000000000000000000000000") },
      { authorization: basic(`crot-${deviceId}`, String(granted.json.access_token)) },
    ];
    for (const headers of unauthorized) {
      const refused = await post(port, "grant_type=client_credentials", headers);
      expect(refused.status).toBe(401);
      expect(refused.json).toEqual({ error: "invalid_client" });
      expect(refused.headers["www-authenticate"]).toBe('Basic realm="crot"');
    }
    expect(log).toContain("oauth: refused a token request with an invalid client secret");
    expect(
      await post(port, `grant_type=client_credentials&client_secret=${encodeURIComponent(client.token)}`, auth),
    ).toMatchObject({ status: 400, json: { error: "invalid_request" } });

    // Requests that are not a server-to-server form POST.
    expect(
      await post(port, "grant_type=client_credentials", { ...auth, origin: "https://evil.example" }),
    ).toMatchObject({ status: 403, json: { error: "invalid_request" } });
    const get = await post(port, "", auth, "GET");
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect(await post(port, "{}", { ...auth, "content-type": "application/json" })).toMatchObject({
      status: 400,
      json: { error: "invalid_request" },
    });
    expect(await post(port, "grant_type=client_credentials&grant_type=refresh_token", auth)).toMatchObject({
      status: 400,
      json: { error: "invalid_request" },
    });
    expect((await post(port, `grant_type=client_credentials&pad=${"x".repeat(9000)}`, auth)).status).toBe(413);

    // A device without a self-registered id has no OAuth client.
    selfId = undefined;
    expect((await post(port, "grant_type=client_credentials", auth)).status).toBe(401);
    expect(JSON.stringify(log)).not.toContain(client.token);
  });
});
