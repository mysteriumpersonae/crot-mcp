/**
 * Relay endpoint reachability probe for the tray "Check endpoint" button. Runs in the Electron main
 * process: the sandboxed renderer never performs network requests itself and never chooses the URL.
 */
export const RELAY_HOST = "crot.network";
const DEVICE_ID = /^[a-z2-7]{26}$/;

export type RelayCheckResult =
  | { readonly state: "unavailable" }
  | { readonly state: "live"; readonly status: number }
  | { readonly state: "tunnel_inactive"; readonly status: 404 }
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

/** Probe the endpoint. Only the HTTP status crosses back into the renderer, never headers or bodies. */
export async function checkRelayEndpoint(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<RelayCheckResult> {
  if (!url) return { state: "unavailable" };
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/event-stream,application/json" },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return { state: "tunnel_inactive", status: 404 };
    if (response.status === 200 || response.status === 202) return { state: "live", status: response.status };
    return { state: "http", status: response.status };
  } catch {
    return { state: "unreachable" };
  }
}
