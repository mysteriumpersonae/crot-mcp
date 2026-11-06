import { it, expect } from "vitest";
import { createCommandHandlers } from "../src/commands.js";
import { FakeChrome } from "./fake-chrome.js";
import {
  AUTOMATION_COMMANDS,
  parseTabPolicy,
  tabPolicyAllows,
  tabPolicyAllowsAutomation,
} from "../../src/core/capabilities/browser/tab-policy.js";
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

it("system publication/OAuth guard overrides permissive owner domains and hides sensitive sessions", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://x.com/compose/post" });
  fake.addTab({ id: 2, windowId: 1, active: false, url: "https://example.com" });
  fake.addTab({ id: 3, windowId: 1, active: false, url: "https://accounts.google.com/o/oauth2/v2/auth?code=PRIVATE" });
  const handlers = createCommandHandlers(fake.api);
  const permissive = {
    mode: "background",
    domains: ["x.com", "accounts.google.com"],
    blockedDomains: [],
    sensitivePreset: false,
  };
  for (const [command, params] of [
    ["tabs.resolve", { tabId: 1 }],
    ["page.read", { tabId: 1, format: "text", maxBytes: 100 }],
    ["page.click", { tabId: 1, selector: "button" }],
    ["page.type", { tabId: 1, selector: "input", text: "post" }],
    ["tabs.open", { url: "https://studio.youtube.com", active: false }],
    ["tabs.navigate", { tabId: 2, url: "https://www.tiktok.com/upload" }],
  ] as const) {
    await expect(handlers[command]({ ...params, __crotTabPolicy: permissive })).rejects.toMatchObject({
      code: "PUBLICATION_BYPASS_DENIED",
    });
  }
  const list = await handlers["tabs.list"]({ __crotTabPolicy: permissive });
  expect(list).toMatchObject({ tabs: [{ tabId: 2 }] });
  expect(JSON.stringify(list)).not.toContain("PRIVATE");
});

it("denies pending navigation to a protected same-origin route", async () => {
  const fake = new FakeChrome();
  fake.addTab({
    id: 1,
    windowId: 1,
    active: true,
    url: "https://x.com/home",
    pendingUrl: "https://x.com/compose/post",
  });
  await expect(createCommandHandlers(fake.api)["tabs.resolve"]({ tabId: 1 })).rejects.toMatchObject({
    code: "PUBLICATION_BYPASS_DENIED",
  });
});

it("refuses social-origin input even when a SPA keeps /home, but permits public reads", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://x.com/home" });
  const handlers = createCommandHandlers(fake.api);
  await expect(handlers["tabs.resolve"]({ tabId: 1 })).resolves.toMatchObject({ tabId: 1 });
  await expect(handlers["page.click"]({ tabId: 1, selector: "button" })).rejects.toMatchObject({
    code: "PUBLICATION_BYPASS_DENIED",
  });
  expect(fake.injections).toHaveLength(0);
});
it("blocks screenshot, legacy page reads and input when the real frame inventory contains OAuth; refuses an unavailable inventory", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com" });
  fake.frameUrls.set(1, ["https://example.com", "https://accounts.google.com/o/oauth2/v2/auth"]);
  const handlers = createCommandHandlers(fake.api);
  for (const command of ["page.screenshot", "page.read", "page.click"] as const)
    await expect(handlers[command]({ tabId: 1, format: "png", selector: "button" })).rejects.toMatchObject({
      code: "PUBLICATION_BYPASS_DENIED",
    });
  expect(fake.injections).toHaveLength(0);
  expect(fake.debugger.sent).toHaveLength(0);
  fake.frameUrls.set(1, []);
  await expect(handlers["tabs.resolve"]({ tabId: 1 })).rejects.toMatchObject({ code: "PUBLICATION_BYPASS_DENIED" });
});

it("targeted + active tab (tab-policy-v2): the owner's focused tab joins the target domains", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com" });
  fake.addTab({ id: 2, windowId: 1, active: false, url: "https://target.test/a" });
  fake.addTab({ id: 3, windowId: 1, active: false, url: "https://other.test" });
  // Active in a background window, not the window the owner looks at.
  fake.addTab({ id: 4, windowId: 2, active: true, url: "https://elsewhere.test" });
  const h = createCommandHandlers(fake.api);
  const both = { ...policy, mode: "targeted", domains: ["target.test"], activeTab: true };
  expect(parseTabPolicy(both)).toEqual(both);
  // activeTab only means something next to target domains; it is dropped elsewhere.
  expect(parseTabPolicy({ ...policy, activeTab: true })).toEqual(policy);
  const list = (await h["tabs.list"]({ __crotTabPolicy: both })) as { tabs: { tabId: number }[] };
  expect(list.tabs.map((t) => t.tabId)).toEqual([1, 2]);
  await expect(h["tabs.resolve"]({ tabId: 1, __crotTabPolicy: both })).resolves.toMatchObject({ tabId: 1 });
  for (const tabId of [3, 4])
    await expect(h["tabs.resolve"]({ tabId, __crotTabPolicy: both })).rejects.toMatchObject({
      code: "BROWSER_PAGE_RESTRICTED",
    });
  const targetOnly = { ...both, activeTab: undefined };
  await expect(h["tabs.resolve"]({ tabId: 1, __crotTabPolicy: targetOnly })).rejects.toMatchObject({
    code: "BROWSER_PAGE_RESTRICTED",
  });
});

it("automation off: no clicks or form input, reading and navigation stay available", async () => {
  const fake = new FakeChrome();
  fake.addTab({ id: 1, windowId: 1, active: true, url: "https://example.com" });
  const h = createCommandHandlers(fake.api);
  const off = parseTabPolicy({ ...policy, automation: false });
  expect(off).toEqual({ ...policy, automation: false });
  expect(parseTabPolicy({ ...policy, automation: true })).toEqual(policy);
  expect(() => parseTabPolicy({ ...policy, automation: "no" })).toThrow("Invalid browser policy");
  for (const [command, params] of [
    ["page.click", { tabId: 1, selector: "button" }],
    ["page.type", { tabId: 1, selector: "input", text: "x" }],
    ["page.select_option", { tabId: 1, selector: "select", values: ["a"] }],
    ["dialog.handle", { tabId: 1, accept: true }],
  ] as const)
    await expect(h[command]({ ...params, __crotTabPolicy: off })).rejects.toMatchObject({
      code: "BROWSER_PAGE_RESTRICTED",
      message: "Clicks and form input are turned off by the owner browser policy",
    });
  expect(fake.injections).toHaveLength(0);
  expect(tabPolicyAllowsAutomation(off, "page.read")).toBe(true);
  expect(tabPolicyAllowsAutomation(off, "tabs.navigate")).toBe(true);
  expect(tabPolicyAllowsAutomation(parseTabPolicy(policy), "page.click")).toBe(true);
  expect(tabPolicyAllowsAutomation(undefined, "page.click")).toBe(true);
  for (const command of AUTOMATION_COMMANDS) expect(tabPolicyAllowsAutomation(off, command)).toBe(false);
  await expect(h["tabs.resolve"]({ tabId: 1, __crotTabPolicy: off })).resolves.toMatchObject({ tabId: 1 });
});
