/**
 * Self-registered device identity (owner-approved, relay `selfRegistration`).
 *
 * One Ed25519 key per installation, kept in the owner-only state file
 * `local-device-id.json`. The device id is derived from the public key
 * (`deviceIdForPublicKey`), so the relay can verify that only the key holder
 * claims it. The id builds `https://<relayHost>/d/<localDeviceId>/mcp`.
 */
import path from "node:path";
import { randomBytes, type KeyObject } from "node:crypto";
import {
  deviceKeyFromSeed,
  devicePublicKey,
  signTunnelProof,
  type DevicePublicKey,
} from "../identity/device-credential.js";
import { deviceIdForPublicKey, isRelayHost, SELF_RELAY_HOST } from "../identity/device-id.js";
import { RELEASE_IDENTITY_ENVIRONMENT } from "../identity/release-environment.js";
import { readStateFile, writeStateFile } from "./private-state.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import type { TunnelCredential } from "./device-binding.js";

const STATE_FILE = "local-device-id.json";

/** Development and test suites only: another relay host for the self-registered tunnel. */
export const SELF_RELAY_HOST_VARIABLE = "CROT_SELF_RELAY_HOST";

/**
 * The relay host of the self-registered tunnel: the canonical `crot.network` (SELF_RELAY_HOST),
 * independent of the identity environment, so the relay URL the tray shows is the one the device
 * registers and tunnels to. `CROT_SELF_RELAY_HOST` names another relay for development and keeps
 * test suites off the public relay; a release build ignores it.
 */
export function resolveSelfRelayHost(
  env: NodeJS.ProcessEnv = process.env,
  release: boolean = RELEASE_IDENTITY_ENVIRONMENT !== undefined,
): { readonly host: string; readonly note?: string } {
  const value = env[SELF_RELAY_HOST_VARIABLE];
  if (value === undefined || value === "") return { host: SELF_RELAY_HOST };
  if (release) return { host: SELF_RELAY_HOST, note: `${SELF_RELAY_HOST_VARIABLE} is ignored in a release build` };
  if (!isRelayHost(value))
    return { host: SELF_RELAY_HOST, note: `${SELF_RELAY_HOST_VARIABLE} is not a relay host; using ${SELF_RELAY_HOST}` };
  return { host: value, note: `the self-registered tunnel uses the development relay ${value}` };
}

export interface LocalDeviceIdentity {
  readonly localDeviceId: string;
  readonly publicKey: DevicePublicKey;
  /** The tunnel credential for a relay host. */
  credential(relayHost: string): TunnelCredential;
}

function identityFromSeed(seed: string): LocalDeviceIdentity {
  const key: KeyObject = deviceKeyFromSeed(seed);
  const publicKey = devicePublicKey(key);
  const localDeviceId = deviceIdForPublicKey(publicKey.x);
  return {
    localDeviceId,
    publicKey,
    credential: (relayHost) => ({
      deviceId: localDeviceId,
      relayHost,
      publicKey,
      prove: (challenge) => signTunnelProof(key, localDeviceId, relayHost, challenge),
    }),
  };
}

/** Load or create the self-registration identity (key + key-derived id). */
export async function loadOrCreateLocalDeviceIdentity(
  stateDir: string,
  privateFiles: PrivateFileProtection,
): Promise<LocalDeviceIdentity> {
  const file = path.join(stateDir, STATE_FILE);
  const result = await readStateFile(file);
  if (result.kind !== "missing") {
    try {
      const v = JSON.parse(result.text) as { seed?: unknown };
      if (typeof v.seed === "string") return identityFromSeed(v.seed);
    } catch {
      // Unreadable or legacy (id without key): create a new key-bound identity.
    }
  }
  const seed = randomBytes(32).toString("base64url");
  const identity = identityFromSeed(seed);
  await writeStateFile(file, JSON.stringify({ version: 2, seed, localDeviceId: identity.localDeviceId }), privateFiles);
  return identity;
}

/** The persistent local device id (key-derived). */
export async function loadOrCreateLocalDeviceId(
  stateDir: string,
  privateFiles: PrivateFileProtection,
): Promise<string> {
  return (await loadOrCreateLocalDeviceIdentity(stateDir, privateFiles)).localDeviceId;
}
