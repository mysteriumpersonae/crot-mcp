import { expect, it } from "vitest";
import { websiteUrl } from "../../src/tray/website.js";
it("opens the current public site, never the retired staging portal", () => {
  expect(websiteUrl("ui.startTrial")).toBe("https://crot.network/?intent=trial");
  expect(websiteUrl("ui.openPortal")).toBe("https://crot.network/");
  expect(websiteUrl("ui.openInstall")).toBe("https://crot.network/#install");
});
