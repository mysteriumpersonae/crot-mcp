import { it, expect } from "vitest";
import { createCommandHandlers } from "../src/commands.js";
import { FakeChrome } from "./fake-chrome.js";
import { parseTabPolicy, tabPolicyAllows } from "../../src/core/capabilities/browser/tab-policy.js";
const policy = { mode: "active", domains: [], blockedDomains: [], sensitivePreset: false };
it("checks actual extension tabs, excludes background and blocks open/navigation destinations", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com" });
  fake.addTab({ id: 2, windowId: 1, active: false, url: "https://target.test" });
  const h = createCommandHandlers(fake.api);
  await expect(h["tabs.resolve"]({ tabId: 2, __crotTabPolicy: policy })).rejects.toMatchObject({
    code: "BROWSER_PAGE_RESTRICTED",
  });
  const list = (await h["tabs.list"]({ __crotTabPolicy: policy })) as { tabs: { tabId: number }[] };
  expect(list.tabs.map((t) => t.tabId)).toEqual([1]);
  await expect(
    h["tabs.open"]({ url: "https://target.test", active: false, __crotTabPolicy: policy }),
  ).rejects.toMatchObject({ code: "BROWSER_PAGE_RESTRICTED" });
  const targeted = { ...policy, mode: "targeted", domains: ["target.test"], blockedDomains: ["private.target.test"] };
  expect(tabPolicyAllows(parseTabPolicy(targeted), "https://target.test", false)).toBe(true);
  await expect(h["tabs.resolve"]({ tabId: 2, __crotTabPolicy: targeted })).resolves.toMatchObject({ tabId: 2 });
  await expect(
    h["tabs.open"]({ url: "https://private.target.test", active: true, __crotTabPolicy: targeted }),
  ).rejects.toMatchObject({ code: "BROWSER_PAGE_RESTRICTED" });
});
it("validates domains and preset before action", () => {
  expect(() => parseTabPolicy({ ...policy, domains: ["*.test"] })).toThrow();
  expect(
    tabPolicyAllows(
      parseTabPolicy({ ...policy, mode: "background", sensitivePreset: true }),
      "https://accounts.google.com",
      true,
    ),
  ).toBe(false);
  expect(
    tabPolicyAllows(
      parseTabPolicy({ ...policy, mode: "background", blockedDomains: ["example.com"] }),
      "https://notexample.com",
      false,
    ),
  ).toBe(true);
});
