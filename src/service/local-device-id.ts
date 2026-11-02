/**
 * Persistent local device identity for unpaired/local-only devices.
 *
 * Generates and stores a stable base32 device ID in the service state
 * directory. This ID is used to build the canonical local relay URL
 * `https://crot.network/d/<localDeviceId>/mcp` for Bearer-token-authenticated
 * connections from Notion Custom MCP and other external clients.
 *
 * Unlike the paired `deviceId` (from `DeviceBinding`, AD-22), this ID
 * is not registered at the cloud relay; it is used only by the local
 * relay bridge (which validates local bearer tokens) and for UI display.
 */
import path from "node:path";
import { generateDeviceId } from "../identity/device-id.js";
import { readStateFile, writeStateFile, type ReadStateResult } from "./private-state.js";
import type { PrivateFileProtection } from "../core/platform/types.js";

const STATE_FILE = "local-device-id.json";

interface LocalDeviceState {
  readonly localDeviceId: string;
}

function parse(result: ReadStateResult): string | undefined {
  if (result.kind === "missing") return undefined;
  try {
    const v = JSON.parse(result.text) as unknown;
    if (typeof v === "object" && v !== null && "localDeviceId" in v && typeof (v as LocalDeviceState).localDeviceId === "string") {
      const id = (v as LocalDeviceState).localDeviceId;
      // Validate: 26 chars, base32 [a-z2-7]
      if (/^[a-z2-7]{26}$/.test(id)) return id;
    }
  } catch {
    // Ignore parse errors; will regenerate
  }
  return undefined;
}

/** Load or generate the persistent local device ID. */
export async function loadOrCreateLocalDeviceId(
  stateDir: string,
  privateFiles: PrivateFileProtection,
): Promise<string> {
  const file = path.join(stateDir, STATE_FILE);
  const result = await readStateFile(file);
  const existing = parse(result);
  if (existing) return existing;
  const localDeviceId = generateDeviceId();
  await writeStateFile(file, JSON.stringify({ localDeviceId }), privateFiles);
  return localDeviceId;
}
