import { describe, it, expect } from "vitest";
import { Script } from "node:vm";
import { CONTROL_CENTER_RENDERER } from "../../src/tray/control-center-renderer.js";
import { AGENTS_CENTER_RENDERER } from "../../src/tray/agents-center-renderer.js";

describe("IPC copy and folder picker wiring", () => {
  it("CONTROL_CENTER_RENDERER compiles without syntax error", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
  });

  it("renderer calls window.crot.pickFolder for __open_folder__ select value", () => {
    expect(CONTROL_CENTER_RENDERER).toContain("__open_folder__");
    expect(CONTROL_CENTER_RENDERER).toContain("pickFolder");
  });

  it("renderer makes folder icon button clickable (calls pickFolder)", () => {
    expect(CONTROL_CENTER_RENDERER).toContain("folderBtn");
    expect(CONTROL_CENTER_RENDERER).toContain("Open project folder");
  });

  it("syncProjects appends Open folder option", () => {
    expect(CONTROL_CENTER_RENDERER).toContain("➕ Open folder...");
  });
});

describe("Agents center copy IPC wiring", () => {
  it("AGENTS_CENTER_RENDERER compiles without syntax error (via CONTROL_CENTER_RENDERER)", () => {
    expect(() => new Script(CONTROL_CENTER_RENDERER)).not.toThrow();
  });

  it("copy function uses window.crot.copyText first", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("window.crot?.copyText");
  });

  it("relay URL copy button passes displayRelayUrl to copy()", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("copy(displayRelayUrl,relayUrlCopy)");
  });

  it("token copy button auto-generates token if none visible", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("tokens.issue");
    expect(AGENTS_CENTER_RENDERER).toContain("copy(r.token,tokenCopy)");
  });

  it("relay endpoint check button probes displayRelayUrl", () => {
    expect(AGENTS_CENTER_RENDERER).toContain("checkRelayBtn");
    expect(AGENTS_CENTER_RENDERER).toContain("Check endpoint");
  });
});
