#!/usr/bin/env node
/**
 * crot-cloud-relay: the CROT Cloud Relay v1 server (ARCHITECTURE.md §22,
 * §27 AD-22; WP-29). Not part of the device package; deployed by WP-38/WP-39.
 *
 *   node dist/bin/crot-cloud-relay.js --config relay.json
 *
 * Logs are JSON lines on stderr without tokens, headers, bodies or paths.
 */
import { readFile } from "node:fs/promises";
import { parseRelayConfig } from "../cloud-relay/config.js";
import { jsonLineLogger } from "../cloud-relay/log.js";
import { AccountService } from "../account-service/service.js";
import { StripeBillingProvider } from "../account-service/billing.js";
import { WorkOSAuthorizationProvider } from "../account-service/provider.js";
import { CloudRelay } from "../cloud-relay/server.js";
import { createIdentityHttp } from "../identity/http.js";
import { IssuerKeySet } from "../identity/jwks.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--config");
  if (i === -1 || !args[i + 1]) throw new Error("usage: crot-cloud-relay --config <file>");
  const config = parseRelayConfig(JSON.parse(await readFile(args[i + 1]!, "utf8")));
  const log = jsonLineLogger();
  const keys = new IssuerKeySet({ issuer: config.issuer, http: createIdentityHttp() });
  const accounts = await AccountService.open(config.registryFile + ".accounts");
  const webhookSecret = process.env.CROT_STRIPE_WEBHOOK_SECRET;
  if (config.commercial && !webhookSecret)
    throw new Error("CROT_STRIPE_WEBHOOK_SECRET is required when commercial billing is configured");
  const relay = new CloudRelay({
    accounts,
    billing:
      config.commercial && webhookSecret
        ? new StripeBillingProvider({ ...config.commercial, webhookSecret, apiKey: process.env.CROT_STRIPE_API_KEY })
        : undefined,
    provider: process.env.CROT_WORKOS_API_KEY
      ? new WorkOSAuthorizationProvider(process.env.CROT_WORKOS_API_KEY)
      : undefined,
    minimumDeviceVersion: config.minimumDeviceVersion,
    limits: config.limits,
    relayHost: config.relayHost,
    issuer: config.issuer,
    pairingClientId: config.pairingClientId,
    environment: config.environment,
    keys,
    registry: accounts,
    exchangeDeadlineMs: config.exchangeDeadlineMs,
    log,
  });
  const tls = config.tls
    ? { cert: await readFile(config.tls.certFile), key: await readFile(config.tls.keyFile) }
    : undefined;
  await relay.listen({ port: config.port, host: config.host, ...(tls ? { tls } : {}) });
  const stop = () => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => {
  process.stderr.write('{"event":"relay.startup_failed"}\n');
  process.exit(1);
});
