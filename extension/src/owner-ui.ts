/** UI-only messages; content scripts and arbitrary extension pages cannot use this channel. */
export function ownerUiAction(
  message: unknown,
  senderUrl: string | undefined,
  origin: string | undefined,
): "status" | "open" | "pair" | undefined {
  if (!origin || !senderUrl || ![origin + "popup.html", origin + "welcome.html"].includes(senderUrl.split("#", 1)[0]!))
    return undefined;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const keys = Object.keys(message);
  const { type, instance } = message as { type?: unknown; instance?: unknown };
  // The owner asks to pair with CROT Desktop (optionally one of several running Desktops).
  if (type === "crot.ui.pair")
    return keys.every((k) => k === "type" || k === "instance") &&
      (instance === undefined || (typeof instance === "string" && /^[0-9a-f]{32}$/.test(instance)))
      ? "pair"
      : undefined;
  if (keys.length !== 1) return undefined;
  return type === "crot.ui.status" ? "status" : type === "crot.ui.openApp" ? "open" : undefined;
}

/** The Desktop instance of a validated crot.ui.pair message, if it names one. */
export function ownerUiPairInstance(message: unknown): string | undefined {
  const instance = (message as { instance?: unknown }).instance;
  return typeof instance === "string" ? instance : undefined;
}
