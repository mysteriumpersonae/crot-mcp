import { ChannelError } from "../service/channel.js";

/**
 * The renderer's answer when a product request fails between the tray and the service: a fixed message and a
 * diagnostic the screens translate, instead of one generic refusal. A service that did not answer in time is
 * told apart from a closed control connection and from a request the service refused; for the chat and OpenCode
 * requests the service's own one-line reason is kept (bounded, control characters removed, anything that looks
 * like a credential redacted).
 */
export interface ProductFailure {
  readonly ok: false;
  readonly message: string;
  readonly diagnostic: {
    readonly code: "SERVICE_TIMEOUT" | "SERVICE_UNAVAILABLE" | "REQUEST_REFUSED";
    readonly stage: "service";
    readonly detail?: string;
  };
}

/** The service's reason as one bounded, redacted line, or undefined when nothing usable is left. */
export function serviceDetail(message: string): string | undefined {
  const line = message
    .slice(0, 2000)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return line ? (line.length > 200 ? `${line.slice(0, 199)}…` : line) : undefined;
}

export function productFailure(method: string, error: unknown): ProductFailure {
  if (error instanceof ChannelError && error.reason === "timeout")
    return {
      ok: false,
      message: "The CROT service did not answer in time.",
      diagnostic: { code: "SERVICE_TIMEOUT", stage: "service" },
    };
  if (error instanceof ChannelError || (error instanceof Error && error.message === "Service disconnected"))
    return {
      ok: false,
      message: "The CROT service is not connected.",
      diagnostic: { code: "SERVICE_UNAVAILABLE", stage: "service" },
    };
  const detail = /^(chat|opencode)\./.test(method) && error instanceof Error ? serviceDetail(error.message) : undefined;
  return {
    ok: false,
    message: "Request refused. Check service policy and connection.",
    diagnostic: { code: "REQUEST_REFUSED", stage: "service", ...(detail ? { detail } : {}) },
  };
}
