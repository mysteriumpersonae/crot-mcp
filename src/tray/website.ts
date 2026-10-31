/** Public website navigation, never the legacy relay portal or an IPC-supplied URL. */
export function websiteUrl(action: "ui.openPortal" | "ui.openInstall" | "ui.startTrial"): string {
  const url = new URL("https://crot.network/");
  if (action === "ui.startTrial") url.searchParams.set("intent", "trial");
  if (action === "ui.openInstall") url.hash = "install";
  return url.href;
}
