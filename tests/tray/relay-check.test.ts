import { describe, expect, it } from "vitest";
import { SELF_RELAY_HOST } from "../../src/identity/device-id.js";
import {
  checkRelayEndpoint,
  classifyRelayResponse,
  RELAY_HOST,
  relayCheckUrl,
  relayCheckVerdict,
} from "../../src/tray/relay-check.js";
import {
  CLAUDE_SVG,
  INTEGRATION_SVG_TREES,
  N8N_SVG,
  NOTION_SVG,
  svgTree,
  type SvgTree,
} from "../../src/tray/integration-svgs.js";
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

  it("tells who answered: this device through the tunnel, or one of the relay's own refusals", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const reply = (status: number, headers: Record<string, string> = {}) =>
      (async (_url: unknown, init?: RequestInit) => {
        seen.push(init);
        return new Response(status === 204 ? null : "secret-body", { status, headers });
      }) as typeof fetch;
    const url = "https://crot.network/d/x/mcp";
    const relay = { "crot-request-outcome": "not_executed" };
    expect(await checkRelayEndpoint(undefined, reply(200))).toEqual({ state: "unavailable" });
    // CROT's own refusal of the throwaway token: the request crossed the tunnel to this device.
    const crot401 = { "www-authenticate": 'Bearer realm="crot", error="invalid_token"' };
    expect(await checkRelayEndpoint(url, reply(401, crot401))).toEqual({ state: "live", status: 401 });
    expect(await checkRelayEndpoint(url, reply(200))).toEqual({ state: "live", status: 200 });
    // The relay's refusals carry its outcome header.
    expect(await checkRelayEndpoint(url, reply(404, relay))).toEqual({ state: "unregistered", status: 404 });
    expect(await checkRelayEndpoint(url, reply(503, relay))).toEqual({ state: "tunnel_inactive", status: 503 });
    const relay401 = { ...relay, "www-authenticate": 'Bearer resource_metadata="https://crot.network/x"' };
    expect(await checkRelayEndpoint(url, reply(401, relay401))).toEqual({ state: "relay_auth", status: 401 });
    expect(await checkRelayEndpoint(url, reply(429, relay))).toEqual({ state: "http", status: 429 });
    // Anything else (a proxy's 502, a 404 or 401 without the relay's header) is never success.
    expect(await checkRelayEndpoint(url, reply(502))).toEqual({ state: "http", status: 502 });
    expect(await checkRelayEndpoint(url, reply(404))).toEqual({ state: "http", status: 404 });
    expect(await checkRelayEndpoint(url, reply(401))).toEqual({ state: "http", status: 401 });
    // Only a throwaway token is ever presented, never a real credential or a cookie.
    const tokens = seen.map((init) => new Headers(init?.headers).get("authorization"));
    for (const token of tokens) expect(token).toMatch(/^Bearer crot-probe-[\w-]{24}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(seen.every((init) => init?.credentials === "omit" && init?.redirect === "error")).toBe(true);
    const failing = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;
    expect(await checkRelayEndpoint(url, failing)).toEqual({ state: "unreachable" });
    expect(classifyRelayResponse(503, new Headers(relay))).toEqual({ state: "tunnel_inactive", status: 503 });
  });

  it("is green for a relay that checks OAuth itself only with the service's tunnel ready", () => {
    const relayAuth = { state: "relay_auth", status: 401 } as const;
    expect(relayCheckVerdict(relayAuth, { state: "ready" })).toEqual({ state: "live", status: 401, tunnel: "ready" });
    expect(relayCheckVerdict(relayAuth, { state: "connecting" })).toEqual({ ...relayAuth, tunnel: "connecting" });
    expect(relayCheckVerdict(relayAuth, undefined)).toEqual(relayAuth);
    // The probe decides: a ready report never turns a relay refusal green.
    expect(relayCheckVerdict({ state: "unregistered", status: 404 }, { state: "ready" })).toEqual({
      state: "unregistered",
      status: 404,
      tunnel: "ready",
    });
    expect(relayCheckVerdict({ state: "unreachable" }, { state: "waiting", reason: "unreachable" })).toEqual({
      state: "unreachable",
      tunnel: "waiting",
    });
    // The URL the tray shows is the relay the device registers at.
    expect(RELAY_HOST).toBe(SELF_RELAY_HOST);
    expect(SELF_RELAY_HOST).toBe("crot.network");
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

  it("keeps every attribute, including names with digits (the Claude spark lines need x1/y1/x2/y2)", () => {
    const count = (tree: SvgTree): number => Object.keys(tree[1]).length + tree[2].reduce((n, c) => n + count(c), 0);
    for (const [name, markup] of [
      ["Notion", NOTION_SVG],
      ["Claude", CLAUDE_SVG],
      ["n8n", N8N_SVG],
    ] as const)
      expect(count(INTEGRATION_SVG_TREES[name]!), name).toBe(markup.match(/\s[a-zA-Z][a-zA-Z0-9:-]*='/g)!.length);
    const spark = INTEGRATION_SVG_TREES.Claude![2][1]!;
    expect(spark[0]).toBe("g");
    expect(spark[2]).toHaveLength(4);
    for (const line of spark[2]) {
      expect(line[0]).toBe("line");
      expect(Object.keys(line[1]).sort()).toEqual(["x1", "x2", "y1", "y2"]);
    }
    expect(spark[2][0]![1]).toEqual({ x1: "0", y1: "-26", x2: "0", y2: "26" });
  });
});
