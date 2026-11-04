/**
 * Relay endpoint reachability probe for the tray "Check tunnel" button. Runs in the Electron main
 * process: the sandboxed renderer never performs network requests itself and never chooses the URL.
 *
 * The probe presents a random Bearer token that is never valid, so the answer tells who replied
 * without any credential: the relay's own refusals carry `crot-request-outcome` (404 unknown device,
 * 503 no open tunnel, 401 when it checks a paired device's OAuth itself), while CROT's 401 for the
 * unknown token (`realm="crot"`, no outcome header) came from this device through the open tunnel.
 */
import { randomBytes } from "node:crypto";
import { SELF_RELAY_HOST } from "../identity/device-id.js";
import { OUTCOME_HEADER } from "../tunnel/protocol.js";

/** The canonical relay of a self-registered device (the URL the tray shows). */
export const RELAY_HOST = SELF_RELAY_HOST;
const DEVICE_ID = /^[a-z2-7]{26}$/;

export type RelayCheckResult =
  | { readonly state: "unavailable" }
  /** The request reached this device through the open tunnel. */
  | { readonly state: "live"; readonly status: number }
  /** The relay does not know this device: it never registered there. */
  | { readonly state: "unregistered"; readonly status: 404 }
  /** The relay knows this device, but no tunnel is open. */
  | { readonly state: "tunnel_inactive"; readonly status: number }
  /** The relay checks this device's OAuth itself (paired device): its tunnel is not visible from here. */
  | { readonly state: "relay_auth"; readonly status: 401 }
  | { readonly state: "http"; readonly status: number }
  | { readonly state: "unreachable" };

/** The only URL the probe may contact: the paired resource URI, else the canonical self-registration URL. */
export function relayCheckUrl(view: {
  readonly resourceUri?: string;
  readonly localDeviceId?: string;
}): string | undefined {
  if (view.resourceUri) {
    try {
      const u = new URL(view.resourceUri);
      if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) return u.href;
    } catch {
      /* fall through to the canonical device URL */
    }
  }
  return view.localDeviceId && DEVICE_ID.test(view.localDeviceId)
    ? `https://${RELAY_HOST}/d/${view.localDeviceId}/mcp`
    : undefined;
}

/** Who answered the probe. Only the state and the HTTP status cross into the renderer, never headers or bodies. */
export function classifyRelayResponse(
  status: number,
  headers: Headers,
): Exclude<RelayCheckResult, { state: "unavailable" | "unreachable" }> {
  if (headers.get(OUTCOME_HEADER) === null) {
    const fromDevice =
      (status === 401 && /realm="crot"/i.test(headers.get("www-authenticate") ?? "")) ||
      (status >= 200 && status < 300);
    return fromDevice ? { state: "live", status } : { state: "http", status };
  }
  if (status === 404) return { state: "unregistered", status: 404 };
  if (status === 503) return { state: "tunnel_inactive", status };
  if (status === 401) return { state: "relay_auth", status: 401 };
  return { state: "http", status };
}

/** Probe the endpoint with a throwaway Bearer token (never a real one). */
export async function checkRelayEndpoint(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<RelayCheckResult> {
  if (!url) return { state: "unavailable" };
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream,application/json",
        authorization: `Bearer crot-probe-${randomBytes(18).toString("base64url")}`,
      },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void response.body?.cancel().catch(() => undefined);
    return classifyRelayResponse(response.status, response.headers);
  } catch {
    return { state: "unreachable" };
  }
}

/** The tunnel as the service reports it after `remote.reconnect`. */
export interface TunnelReport {
  readonly state: string;
  readonly reason?: string;
}

/**
 * The result the renderer shows. Green (`live`) only when a request really reached this device
 * through the tunnel — or, for a paired device whose relay checks OAuth first, when the relay is
 * reachable and the service reports its tunnel ready.
 */
export function relayCheckVerdict(
  probe: RelayCheckResult,
  tunnel: TunnelReport | undefined,
): RelayCheckResult & { readonly tunnel?: string } {
  const withTunnel = tunnel ? { tunnel: tunnel.state } : {};
  if (probe.state === "relay_auth" && tunnel?.state === "ready") return { state: "live", status: 401, ...withTunnel };
  return { ...probe, ...withTunnel };
}
