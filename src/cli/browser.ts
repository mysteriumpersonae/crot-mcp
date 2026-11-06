import { bridgeTokenFile } from "../browser-bridge/endpoint.js";
import { LOOPBACK_PORTS, LoopbackServer, browserPairingsFile } from "../browser-bridge/loopback.js";
import { BrowserBridge, type BrowserBridgeOptions } from "../browser-bridge/server.js";
import { CORE_VERSION } from "../core/crot-core.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import type { BrowserLinkHost } from "../service/product-runtime.js";
import { RELEASE_EXTENSION_ORIGINS } from "./release-extension-ids.js";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Host-side wiring of the browser bridge (ARCHITECTURE.md §16).
 *
 * The bridge is a transport only: it is handed to Core as its browser
 * connection and every browser tool call is still authorized by the
 * PermissionEngine. Nothing here grants a capability.
 */
export interface BrowserWiringOptions {
  readonly openControlCenter?: () => Promise<boolean>;
  /** `browser.enabled` from the parsed configuration. */
  readonly enabled: boolean;
  /** CROT state directory (token file, POSIX socket). */
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  /** Source of the bridge token (the service's secret store); default: the token file. */
  readonly token?: () => Promise<string>;
  /** Diagnostics on stderr (never receives the token). */
  readonly log: (message: string) => void;
  /** Replace BrowserBridge.start (tests). */
  readonly start?: (options: BrowserBridgeOptions) => Promise<BrowserBridge>;
  /** Ports of the loopback discovery endpoint (loopbackPorts()); undefined: no loopback endpoint. */
  readonly loopbackPorts?: readonly number[] | undefined;
  /** Unpacked extension directory, if explicitly configured by the service host. */
  readonly extensionDir?: string | undefined;
}

export function browserBootstrapPath(extensionDir: string): string {
  return path.join(extensionDir, ".bridge-secret.json");
}

/** Atomic, owner-only provisioning. Never writes the secret before ACL protection. */
export async function provisionBrowserBootstrap(
  directory: string,
  credential: { instance: string; pairing: string; secret: string },
  privateFiles: PrivateFileProtection,
): Promise<void> {
  if (!privateFiles.enforced || (!privateFiles.protectFile && privateFiles.fileMode === undefined))
    throw new Error("owner-only file protection is unavailable");
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("extension directory is not a regular directory");
  if (process.getuid && (dir.uid !== process.getuid() || (dir.mode & 0o022) !== 0))
    throw new Error("extension directory must be owned by the current user and not group/world writable");
  const manifestPath = path.join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("extension manifest is unavailable");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("invalid extension manifest");
  const { key, web_accessible_resources: exposed } = manifest as { key?: unknown; web_accessible_resources?: unknown };
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(key) ||
    (exposed !== undefined && (!Array.isArray(exposed) || exposed.length > 0))
  )
    throw new Error("extension identity or resource policy is invalid");
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const extensionId = [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  if (!RELEASE_EXTENSION_ORIGINS.includes(`chrome-extension://${extensionId}/`))
    throw new Error("extension identity is not a trusted release");
  const target = browserBootstrapPath(directory);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
    throw new Error("unsafe extension credential file");
  if (existing && process.getuid && existing.uid !== process.getuid())
    throw new Error("credential file owner mismatch");
  const tmp = target + "." + randomBytes(12).toString("hex") + ".tmp";
  let file;
  try {
    file = await open(tmp, "wx", privateFiles.fileMode ?? 0o600);
    await privateFiles.protectFile?.(tmp);
    if (privateFiles.mechanism === "posix-mode") await file.chmod(0o600);
    await file.writeFile(JSON.stringify({ version: 1, ...credential }) + "\n", "utf8");
    await file.close();
    file = undefined;
    await rename(tmp, target);
  } finally {
    await file?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Ports of the loopback discovery endpoint from CROT_BROWSER_LOOPBACK_PORTS:
 * unset: 43115-43119; "off": none; "0": a free port (tests); otherwise a comma-separated list.
 */
export function loopbackPorts(env: Readonly<Record<string, string | undefined>>): readonly number[] | undefined {
  const raw = env.CROT_BROWSER_LOOPBACK_PORTS?.trim();
  if (!raw) return LOOPBACK_PORTS;
  if (raw === "off") return undefined;
  const ports = raw.split(",").map((p) => Number(p.trim()));
  return ports.length <= 8 && ports.every((p) => Number.isInteger(p) && p >= 0 && p <= 65535) ? ports : LOOPBACK_PORTS;
}

/**
 * Files that CROT tools may never touch when the browser bridge is enabled:
 * the bridge token file and the loopback pairing metadata. The paths are
 * deterministic, so they are protected even when the bridge fails to start.
 */
export function browserProtectedPaths(enabled: boolean, stateDir: string): string[] {
  return enabled ? [bridgeTokenFile(stateDir), browserPairingsFile(stateDir)] : [];
}

/**
 * Start the browser bridge when it is enabled. A bridge that cannot start
 * (invalid token file, a non-socket file at the socket path, a socket path
 * that is too long, ...) never stops CROT: a warning is logged and CROT runs
 * without a browser connection. Another CROT instance owning the bridge is not
 * an error: the bridge then stays in_use for its lifetime.
 */
export async function startBrowserBridge(options: BrowserWiringOptions): Promise<BrowserBridge | undefined> {
  if (!options.enabled) return undefined;
  const start = options.start ?? ((o: BrowserBridgeOptions) => BrowserBridge.start(o));
  let bridge: BrowserBridge;
  try {
    bridge = await start({
      stateDir: options.stateDir,
      privateFiles: options.privateFiles,
      ...(options.token ? { token: options.token } : {}),
      log: options.log,
      ...(options.openControlCenter ? { openControlCenter: options.openControlCenter } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.log(`warning: browser bridge unavailable: ${detail}; continuing without browser tools`);
    return undefined;
  }
  const status = bridge.status();
  if (status.state === "in_use") {
    options.log(
      "browser bridge: in use by another CROT instance; browser operations fail with BROWSER_BRIDGE_IN_USE in this instance",
    );
  } else {
    options.log(`browser bridge: ${status.state} for the CROT Browser Extension on ${status.endpoint.path}`);
  }
  // Discovery for browsers without the native host (only in the instance that owns the bridge).
  if (options.loopbackPorts && bridge.owner) {
    try {
      const loopback = await LoopbackServer.start({
        bridge,
        stateDir: options.stateDir,
        privateFiles: options.privateFiles,
        version: CORE_VERSION,
        extensionOrigins: RELEASE_EXTENSION_ORIGINS.map((o) => o.replace(/\/$/, "")),
        log: options.log,
        ports: options.loopbackPorts,
      });
      bridge.attachLoopback(loopback);
      if (options.extensionDir && loopback.port !== undefined) {
        const credential = loopback.nativeBootstrap();
        if (credential)
          try {
            await provisionBrowserBootstrap(options.extensionDir, credential, options.privateFiles);
          } catch {
            options.log("warning: browser bootstrap file unavailable; native messaging still works");
          }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.log(`warning: browser loopback discovery unavailable: ${detail}; native messaging still works`);
    }
  }
  return bridge;
}

/**
 * The owner's view of the browser link on the Control Center Browser screen:
 * the connection state (never the token or the endpoint path) and the loopback
 * legacy pairings the owner can forget. No new manual pairings are created.
 * Undefined while the bridge is turned off.
 */
export function browserLinkHost(bridge: BrowserBridge | undefined): BrowserLinkHost | undefined {
  if (!bridge) return undefined;
  return {
    status() {
      const state = bridge.state();
      const loopback = bridge.loopbackEndpoint?.status();
      return {
        state: state.kind,
        ...(state.kind === "connected"
          ? {
              browser: state.browser,
              transport: state.transport ?? "native",
              cdp: state.cdp?.available === true,
              manage: (state.features ?? []).includes("ui-manage"),
            }
          : {}),
        sessions: bridge.sessions(),
        selection: bridge.selection ?? null,
        tabsRevision: bridge.tabsRevision,
        ...(loopback
          ? {
              loopback: {
                ...(loopback.port !== undefined ? { port: loopback.port } : {}),
                conflicts: loopback.conflicts,
                pending: [],
                pairings: loopback.pairings.map(({ id, browser, created, connected }) => ({
                  id,
                  browser,
                  created,
                  connected,
                })),
              },
            }
          : {}),
      };
    },
    select: (id) => bridge.select(id),
    approve: async (id) => (await bridge.loopbackEndpoint?.approve(id)) === true,
    reject: (id) => bridge.loopbackEndpoint?.reject(id) === true,
    forget: async (id) => (await bridge.loopbackEndpoint?.forget(id)) === true,
    manage: () => bridge.manageExtension(),
  };
}
