/** Co-hosted account API. Router must call this ONLY for commercial routes, never for /mcp. */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WindowCounter } from "../cloud-relay/limits.js";
import type { DeviceRecord } from "../cloud-relay/registry.js";
import { verifyCommercialProof, type CommercialAction } from "../identity/device-credential.js";
import type { SigningKeySource } from "../identity/jwks.js";
import { checkAccessToken } from "../identity/verifier.js";
import { BillingError, type BillingProvider } from "./billing.js";
import { CommercialError, type CommercialService } from "./service.js";
import type { AuthorizationProvider } from "./provider.js";
export const ACCOUNT_PATH = "/.crot/account";
interface Options {
  service: CommercialService;
  relayHost: string;
  issuer: string;
  pairingClientId: string;
  keys: SigningKeySource;
  billing?: BillingProvider;
  provider?: AuthorizationProvider;
  online(deviceId: string): boolean;
  now?: () => number;
}
export class AccountHttpApi {
  private readonly challenges = new Map<
    string,
    { record: DeviceRecord; expires: number; action: CommercialAction; clientId: string }
  >();
  private readonly rates: WindowCounter;
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.rates = new WindowCounter({ max: 60, windowMs: 60_000 }, this.now, 4096);
  }
  matches(pathname: string): boolean {
    return (
      pathname === ACCOUNT_PATH ||
      pathname.startsWith(ACCOUNT_PATH + "/") ||
      pathname === "/.crot/billing/stripe" ||
      /^\/d\/[a-z2-7]{26}\/account(?:\/challenge)?$/.test(pathname)
    );
  }
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const reply = (status: number, data: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "CROT-Request-Outcome": "not_executed",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    if (!req.complete) {
      const timer = setTimeout(() => req.socket.destroy(), 5000);
      timer.unref();
      req.once("end", () => clearTimeout(timer));
      req.once("close", () => clearTimeout(timer));
    }
    try {
      if (this.rates.take(req.socket.remoteAddress ?? "unknown") !== undefined) {
        req.resume();
        return reply(429, { error: "rate_limited" });
      }
      if (pathname === "/.crot/billing/stripe") {
        if (req.method !== "POST" || !this.options.billing) {
          req.resume();
          return reply(404, { error: "not_found" });
        }
        const raw = await readCommercialBody(req, 256 * 1024);
        const signature = req.headers["stripe-signature"];
        const update = this.options.billing.verify(raw, typeof signature === "string" ? signature : undefined);
        if (update) await this.options.service.applyBilling(update);
        return reply(200, { received: true });
      }
      const deviceMatch = /^\/d\/([a-z2-7]{26})\/account(\/challenge)?$/.exec(pathname);
      if (deviceMatch) {
        if (req.method !== "POST") {
          req.resume();
          return reply(405, { error: "method_not_allowed" });
        }
        const deviceId = deviceMatch[1]!;
        const record = await this.options.service.get(deviceId);
        if (!record) {
          req.resume();
          return reply(404, { error: "not_found" });
        }
        const value = JSON.parse((await readCommercialBody(req, 4096)).toString("utf8")) as Record<string, unknown>;
        if (!value || typeof value !== "object" || Array.isArray(value))
          return reply(400, { error: "invalid_request" });
        const { action } = value;
        const clientId = value.clientId ?? "";
        if (
          !value ||
          !["status", "revoke_client"].includes(String(action)) ||
          typeof clientId !== "string" ||
          clientId.length > 512 ||
          /[\x00-\x20]/.test(clientId) ||
          (action === "status" && clientId !== "") ||
          (action === "revoke_client" && clientId === "")
        )
          return reply(400, { error: "invalid_request" });
        if (deviceMatch[2]) {
          for (const [key, c] of this.challenges) if (c.expires <= this.now()) this.challenges.delete(key);
          if (this.challenges.size >= 1024) return reply(503, { error: "busy" });
          const challenge = randomBytes(32).toString("base64url");
          this.challenges.set(challenge, {
            record,
            expires: this.now() + 30_000,
            action: action as CommercialAction,
            clientId,
          });
          return reply(200, { challenge });
        }
        const { challenge, proof } = value;
        if (typeof challenge !== "string" || typeof proof !== "string") return reply(403, { error: "invalid_proof" });
        const pending = this.challenges.get(challenge);
        // Single-use even on bad proofs; domain and full action payload are cryptographically bound.
        this.challenges.delete(challenge);
        if (
          !pending ||
          pending.record.accountId !== record.accountId ||
          pending.record.publicKey.x !== record.publicKey.x ||
          pending.action !== action ||
          pending.clientId !== clientId ||
          pending.expires <= this.now() ||
          !verifyCommercialProof(
            record.publicKey,
            deviceId,
            this.options.relayHost,
            Buffer.from(challenge, "base64url"),
            action as CommercialAction,
            clientId,
            Buffer.from(proof, "base64url"),
          )
        )
          return reply(403, { error: "invalid_proof" });
        // Recheck after asynchronous body read; remote revocation cannot race a pending challenge.
        if (!(await this.options.service.get(deviceId))) return reply(404, { error: "not_found" });
        if (action === "status")
          return reply(200, {
            ...this.options.service.view(record.accountId),
            entitled: (await this.options.service.entitlement(record)) === "entitled",
          });
        if (
          !this.options.service
            .clients(record.accountId)
            .some((c) => c.deviceId === deviceId && c.clientId === clientId)
        )
          return reply(404, { error: "unknown_client" });
        return reply(200, {
          provider: this.options.provider
            ? await this.options.provider.revoke(record.accountId, clientId)
            : "not_available",
        });
      }
      // Owner administration needs the ACCOUNT audience, never a remote MCP resource token.
      const auth = req.headers.authorization;
      const token = typeof auth === "string" && /^Bearer [^ ]+$/.test(auth) ? auth.slice(7) : undefined;
      if (!token) {
        req.resume();
        return reply(401, { error: "unauthorized" });
      }
      const checked = await checkAccessToken(token, {
        issuer: this.options.issuer,
        audience: `https://${this.options.relayHost}${ACCOUNT_PATH}`,
        keys: this.options.keys,
        nowSeconds: this.now() / 1000,
      });
      if (!checked.ok || checked.token.clientId !== this.options.pairingClientId) {
        req.resume();
        return reply(401, { error: "unauthorized" });
      }
      const accountId = checked.token.subject;
      if (pathname === ACCOUNT_PATH && req.method === "GET") {
        req.resume();
        return reply(200, {
          ...this.options.service.view(accountId),
          devices: this.options.service.deviceList(accountId).map((d) => ({
            deviceId: d.deviceId,
            registeredAt: d.registeredAt,
            online: this.options.online(d.deviceId),
          })),
          clients: this.options.service.clients(accountId),
        });
      }
      if (pathname === ACCOUNT_PATH + "/trial" && req.method === "POST") {
        await readCommercialBody(req, 4096);
        await this.options.service.startTrial(accountId);
        return reply(200, this.options.service.view(accountId));
      }
      const revoke = /^\/\.crot\/account\/devices\/([a-z2-7]{26})$/.exec(pathname);
      if (revoke && req.method === "DELETE") {
        await readCommercialBody(req, 4096);
        await this.options.service.revoke(accountId, revoke[1]!);
        // Account-wide provider calls are best effort, after durable local/cloud revocation.
        const clients = this.options.service.clients(accountId).filter((c) => c.deviceId === revoke[1]);
        const results = await Promise.all(
          clients.map((c) => this.options.provider?.revoke(accountId, c.clientId) ?? Promise.resolve("not_available")),
        );
        return reply(200, { revoked: true, provider: results });
      }
      if (pathname === ACCOUNT_PATH + "/checkout" && req.method === "POST") {
        const value = JSON.parse((await readCommercialBody(req, 4096)).toString("utf8")) as { plan?: unknown };
        if (!["pro", "team"].includes(String(value?.plan))) return reply(400, { error: "invalid_plan" });
        if (!this.options.billing) return reply(503, { error: "billing_unavailable" });
        return reply(200, { url: await this.options.billing.checkout(accountId, value.plan as "pro" | "team") });
      }
      req.resume();
      reply(404, { error: "not_found" });
    } catch (error) {
      req.resume();
      if (error instanceof CommercialError) return reply(error.code === "not_found" ? 404 : 403, { error: error.code });
      if (error instanceof BillingError) return reply(400, { error: "invalid_billing_event" });
      if (error instanceof SyntaxError) return reply(400, { error: "invalid_request" });
      if (error instanceof BodyError) return reply(error.status, { error: "invalid_request" });
      reply(503, { error: "commercial_unavailable" });
    }
  }
}
class BodyError extends Error {
  constructor(readonly status: number) {
    super("invalid_request");
  }
}
function readCommercialBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: BodyError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
      chunks.length = 0;
    };
    const timer = setTimeout(() => {
      finish(new BodyError(408));
      req.socket.destroy();
    }, 5000);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        finish(new BodyError(413));
        req.socket.destroy();
      } else chunks.push(chunk);
    });
    req.once("end", () => finish());
    req.once("error", () => finish(new BodyError(400)));
    req.once("close", () => {
      if (!req.complete) finish(new BodyError(400));
    });
  });
}
