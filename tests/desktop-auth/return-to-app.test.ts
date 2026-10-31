import { describe, expect, it, vi } from "vitest";
import { createAppReturn } from "../../src/desktop-auth/return-to-app.js";
describe("single-use local window activation", () => {
  it("requires POST, exact origin, capability and permits one activation without auth data", async () => {
    const activate = vi.fn(() => true),
      origin = "http://127.0.0.1:43821";
    const link = await createAppReturn(origin, activate);
    try {
      expect((await fetch(link.url)).status).toBe(403);
      expect((await fetch(link.url, { method: "POST", headers: { origin: "https://evil.test" } })).status).toBe(403);
      expect((await fetch(link.url, { method: "POST" })).status).toBe(403);
      expect((await fetch(link.url + "x", { method: "POST", headers: { origin } })).status).toBe(403);
      expect(activate).not.toHaveBeenCalled();
      const result = await fetch(link.url, { method: "POST", headers: { origin } });
      expect(result.status).toBe(204);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(await result.text()).toBe("");
      expect(result.headers.get("access-control-allow-origin")).toBe(origin);
      expect(activate).toHaveBeenCalledTimes(1);
      expect((await fetch(link.url, { method: "POST", headers: { origin } })).status).toBe(403);
      expect(activate).toHaveBeenCalledTimes(1);
    } finally {
      link.close();
    }
  });
  it("closed capability is unavailable", async () => {
    const activate = vi.fn(() => false),
      link = await createAppReturn("http://127.0.0.1:43821", activate);
    link.close();
    await expect(fetch(link.url)).rejects.toThrow();
    expect(activate).not.toHaveBeenCalled();
  });
});
