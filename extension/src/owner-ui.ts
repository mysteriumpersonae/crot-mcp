/** UI-only messages; content scripts and arbitrary extension pages cannot use this channel. */
export function ownerUiAction(
  message: unknown,
  senderUrl: string | undefined,
  origin: string | undefined,
): "status" | "open" | undefined {
  if (!origin || !senderUrl || ![origin + "popup.html", origin + "welcome.html"].includes(senderUrl.split("#", 1)[0]!))
    return undefined;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const keys = Object.keys(message);
  const { type } = message as { type?: unknown };
  if (keys.length !== 1) return undefined;
  return type === "crot.ui.status" ? "status" : type === "crot.ui.openApp" ? "open" : undefined;
}
