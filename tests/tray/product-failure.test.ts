import { describe, expect, it } from "vitest";
import { ChannelError } from "../../src/service/channel.js";
import { longRequest } from "../../src/service/control-client.js";
import { productFailure, serviceDetail } from "../../src/tray/product-failure.js";

describe("tray answers for failed product requests", () => {
  it("tells a service that did not answer from a closed connection and from a refused request", () => {
    expect(
      productFailure(
        "chat.testConnection",
        new ChannelError("timeout", "The CROT service did not answer 'chat.testConnection'."),
      ),
    ).toEqual({
      ok: false,
      message: "The CROT service did not answer in time.",
      diagnostic: { code: "SERVICE_TIMEOUT", stage: "service" },
    });
    for (const error of [new ChannelError("closed", "closed"), new Error("Service disconnected")])
      expect(productFailure("chat.models", error)).toEqual({
        ok: false,
        message: "The CROT service is not connected.",
        diagnostic: { code: "SERVICE_UNAVAILABLE", stage: "service" },
      });
    // The chat and OpenCode requests keep the service's reason; other requests only the code.
    expect(productFailure("chat.configure", new Error("Configure the chat provider first"))).toEqual({
      ok: false,
      message: "Request refused. Check service policy and connection.",
      diagnostic: { code: "REQUEST_REFUSED", stage: "service", detail: "Configure the chat provider first" },
    });
    expect(productFailure("opencode.install", new Error("Stop the active generation first")).diagnostic).toEqual({
      code: "REQUEST_REFUSED",
      stage: "service",
      detail: "Stop the active generation first",
    });
    expect(productFailure("accounts.connect", new Error("secret reason")).diagnostic).toEqual({
      code: "REQUEST_REFUSED",
      stage: "service",
    });
    expect(productFailure("chat.configure", "not an error").diagnostic).toEqual({
      code: "REQUEST_REFUSED",
      stage: "service",
    });
  });

  it("bounds the service's reason and redacts what looks like a credential", () => {
    expect(serviceDetail("bad\nline\u0007 Bearer abc sk-0123456789abcdef " + "A".repeat(48))).toBe(
      "bad line Bearer [redacted] [redacted] [redacted]",
    );
    const long = serviceDetail("word ".repeat(100))!;
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(serviceDetail(" \n ")).toBeUndefined();
  });

  it("gives Save & Test and the model list the long timeout (local OpenCode may start first)", () => {
    for (const method of ["chat.testConnection", "chat.models", "opencode.install", "opencode.status", "agents.list"])
      expect(longRequest(method), method).toBe(true);
    for (const method of ["chat.configure", "chat.poll", "chat.providers", "status", "accounts.connect"])
      expect(longRequest(method), method).toBe(false);
  });
});
