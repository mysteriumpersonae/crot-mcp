/**
 * The credential forms MCP clients present (src/adapters/http/credentials.ts): Bearer, Basic and
 * API-key headers carry the same client token; OAuth client authentication of token requests.
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_HEADERS,
  oauthClientCredentials,
  presentedCredential,
  selfOAuthClientId,
  selfOAuthDevice,
  singleValueForm,
} from "../../src/adapters/http/credentials.js";
import { generateDeviceId } from "../../src/identity/device-id.js";

const TOKEN = "tok_0123456789abcdefABCDEF-xyz.~";
const basic = (value: string) => `Basic ${Buffer.from(value, "utf8").toString("base64")}`;

describe("presentedCredential", () => {
  it("reads one token from Bearer, Basic and API-key headers", () => {
    expect(presentedCredential(["Authorization", `Bearer ${TOKEN}`])).toEqual({ token: TOKEN, scheme: "bearer" });
    expect(presentedCredential(["authorization", `bearer   ${TOKEN}  `])).toEqual({ token: TOKEN, scheme: "bearer" });
    // Basic: the password, or the user name when the password is empty.
    for (const pair of [`crot:${TOKEN}`, `${TOKEN}:`, TOKEN, `anything:${TOKEN}`])
      expect(presentedCredential(["Authorization", basic(pair)])).toEqual({ token: TOKEN, scheme: "basic" });
    expect(API_KEY_HEADERS).toEqual(["x-api-key", "api-key", "x-crot-token"]);
    for (const name of ["X-API-Key", "Api-Key", "X-CROT-Token", "x-api-key"]) {
      expect(presentedCredential([name, TOKEN])).toEqual({ token: TOKEN, scheme: "api-key" });
      // A pasted "Bearer " prefix is ignored.
      expect(presentedCredential([name, `Bearer ${TOKEN}`])).toEqual({ token: TOKEN, scheme: "api-key" });
    }
    // The same token in two forms is one credential.
    expect(presentedCredential(["Authorization", `Bearer ${TOKEN}`, "X-API-Key", TOKEN])).toEqual({
      token: TOKEN,
      scheme: "bearer",
    });
    expect(presentedCredential(["Content-Type", "application/json"])).toBe("missing");
    expect(presentedCredential([])).toBe("missing");
  });

  it("refuses repeated, malformed and conflicting credentials", () => {
    const malformed: string[][] = [
      ["Authorization", `Bearer ${TOKEN}`, "Authorization", `Bearer ${TOKEN}`],
      ["X-API-Key", TOKEN, "x-api-key", TOKEN],
      ["Authorization", "Bearer"],
      ["Authorization", `Bearer ${TOKEN} extra`],
      ["Authorization", `Digest ${TOKEN}`],
      ["Authorization", "Basic not*base64"],
      ["Authorization", `Basic ${Buffer.from([0xff, 0xfe, 0x3a, 0x41]).toString("base64")}`],
      ["Authorization", basic(":")],
      ["Authorization", basic("crot:with space")],
      ["X-API-Key", "with space"],
      ["X-API-Key", "x".repeat(8193)],
      ["Authorization", `Bearer ${TOKEN}`, "X-API-Key", "another-token-0000"],
      ["X-API-Key", TOKEN, "X-CROT-Token", "another-token-0000"],
    ];
    for (const headers of malformed) expect(presentedCredential(headers), headers.join(" ")).toBe("malformed");
  });

  it("keeps the Bearer form only when bearerOnly (paired relay requests)", () => {
    expect(presentedCredential(["Authorization", `Bearer ${TOKEN}`], { bearerOnly: true })).toEqual({
      token: TOKEN,
      scheme: "bearer",
    });
    expect(presentedCredential(["Authorization", basic(`crot:${TOKEN}`)], { bearerOnly: true })).toBe("malformed");
    expect(presentedCredential(["X-API-Key", TOKEN], { bearerOnly: true })).toBe("missing");
    expect(
      presentedCredential(["Authorization", `Bearer ${TOKEN}`, "X-API-Key", "other"], { bearerOnly: true }),
    ).toEqual({
      token: TOKEN,
      scheme: "bearer",
    });
  });
});

describe("self OAuth client ids", () => {
  it("names the device as crot-<deviceId> (the bare id too)", () => {
    const id = generateDeviceId();
    expect(selfOAuthClientId(id)).toBe(`crot-${id}`);
    expect(selfOAuthDevice(selfOAuthClientId(id))).toBe(id);
    expect(selfOAuthDevice(id)).toBe(id);
    for (const bad of [undefined, "", "crot-", `crot-${id}x`, `CROT-${id}`, id.toUpperCase(), `x-${id}`, "crot-short"])
      expect(selfOAuthDevice(bad)).toBeUndefined();
  });
});

describe("oauthClientCredentials", () => {
  const form = (value: string) => new URLSearchParams(value);
  const encoded = (id: string, secret: string) => basic(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`);

  it("accepts client_secret_basic (form-urlencoded parts) and client_secret_post", () => {
    expect(oauthClientCredentials(encoded("crot-a", "s3:cr+et%"), form(""))).toEqual({
      id: "crot-a",
      secret: "s3:cr+et%",
    });
    expect(oauthClientCredentials(basic("crot-a:plain"), form("client_id=crot-a"))).toEqual({
      id: "crot-a",
      secret: "plain",
    });
    expect(oauthClientCredentials(undefined, form("client_id=crot-a&client_secret=s%2B1"))).toEqual({
      id: "crot-a",
      secret: "s+1",
    });
    expect(oauthClientCredentials(undefined, form("grant_type=client_credentials"))).toBeUndefined();
    expect(oauthClientCredentials(undefined, form("client_id=crot-a"))).toBeUndefined();
  });

  it("refuses malformed or double client authentication", () => {
    for (const [authorization, body] of [
      [basic("crot-a:one"), "client_secret=two"],
      [basic("crot-a:one"), "client_id=crot-b"],
      [basic("no-colon"), ""],
      [basic("crot-a:"), ""],
      [basic(":secret"), ""],
      ["Bearer abc", ""],
      ["Basic ***", ""],
      [undefined, "client_id=&client_secret=x"],
      [undefined, "client_id=crot-a&client_secret="],
    ] as const)
      expect(oauthClientCredentials(authorization, form(body)), `${authorization} ${body}`).toBe("invalid");
  });
});

describe("singleValueForm", () => {
  it("accepts each parameter once", () => {
    expect(singleValueForm("a=1&b=2")?.get("b")).toBe("2");
    expect([...singleValueForm("")!.keys()]).toEqual([]);
    expect(singleValueForm("a=1&a=2")).toBeUndefined();
  });
});
