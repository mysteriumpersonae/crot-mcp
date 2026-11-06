import { bridgeTokenFile } from "../browser-bridge/endpoint.js";
import { LOOPBACK_PORTS, LoopbackServer, browserPairingsFile } from "../browser-bridge/loopback.js";
import { BrowserBridge, type BrowserBridgeOptions } from "../browser-bridge/server.js";
import { CORE_VERSION } from "../core/crot-core.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import type { BrowserLinkHost } from "../service/product-runtime.js";
import { RELEASE_EXTENSION_ORIGINS } from "./release-extension-ids.js";

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
      bridge.attachLoopback(
        await LoopbackServer.start({
          bridge,
          stateDir: options.stateDir,
          privateFiles: options.privateFiles,
          version: CORE_VERSION,
          extensionOrigins: RELEASE_EXTENSION_ORIGINS.map((o) => o.replace(/\/$/, "")),
          log: options.log,
          ports: options.loopbackPorts,
        }),
      );
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
 * pairing requests and pairings the owner approves, rejects or forgets.
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
                pending: loopback.pending.map(({ id, code, browser, expiresAt }) => ({ id, code, browser, expiresAt })),
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
