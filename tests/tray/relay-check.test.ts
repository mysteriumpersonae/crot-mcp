import { describe, expect, it } from "vitest";
import { checkRelayEndpoint, relayCheckUrl } from "../../src/tray/relay-check.js";
import { INTEGRATION_SVG_TREES, svgTree } from "../../src/tray/integration-svgs.js";
import { AGENTS_CENTER_RENDERER } from "../../src/tray/agents-center-renderer.js";

const ID = "abcdefghijklmnopqrstuvwxyz".slice(0, 26);

describe("relay endpoint check runs in the main process", () => {
  it("derives the probe URL only from the view (paired resource or canonical device URL)", () => {
    expect(relayCheckUrl({ resourceUri: "https://relay.example/d/x/mcp" })).toBe("https://relay.example/d/x/mcp");
    expect(relayCheckUrl({ resourceUri: "http://relay.example/d/x/mcp", localDeviceId: ID })).toBe(
      `https://crot.network/d/${ID}/mcp`,
    );
    expect(relayCheckUrl({ resourceUri: "https://u:p@relay.example/d/x/mcp" })).toBeUndefined();
    expect(relayCheckUrl({ localDeviceId: "../../evil" })).toBeUndefined();
    expect(relayCheckUrl({})).toBeUndefined();
  });

  it("maps HTTP outcomes to states and never forwards bodies or headers", async () => {
    const reply = (status: number) => (async () => new Response("secret-body", { status })) as typeof fetch;
    expect(await checkRelayEndpoint(undefined, reply(200))).toEqual({ state: "unavailable" });
    expect(await checkRelayEndpoint("https://crot.network/d/x/mcp", reply(200))).toEqual({
      state: "live",
      status: 200,
    });
    expect(await checkRelayEndpoint("https://crot.network/d/x/mcp", reply(404))).toEqual({
      state: "tunnel_inactive",
      status: 404,
    });
    expect(await checkRelayEndpoint("https://crot.network/d/x/mcp", reply(502))).toEqual({
      state: "http",
      status: 502,
    });
    const failing = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    expect(await checkRelayEndpoint("https://crot.network/d/x/mcp", failing)).toEqual({ state: "unreachable" });
  });

  it("renderer uses the IPC bridge, not fetch or markup injection", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("window.crot?.checkRelay?.()");
    expect(AGENTS_CENTER_RENDERER).not.toMatch(/fetch\(|innerHTML|insertAdjacentHTML|DOMParser/);
    expect(AGENTS_CENTER_RENDERER).toContain("document.createElementNS('http://www.w3.org/2000/svg',tag)");
  });
});

describe("integration logos are structured SVG data", () => {
  it("parses the bundled logos and rejects anything outside the allowlist", () => {
    for (const name of ["Notion", "Claude", "n8n"]) expect(INTEGRATION_SVG_TREES[name]![0]).toBe("svg");
    expect(() => svgTree("<svg><script>alert(1)</script></svg>")).toThrow();
    expect(() => svgTree("<svg onload='x'></svg>")).toThrow();
    expect(() => svgTree("<svg><rect/>text</svg>")).toThrow();
  });
});
