import { it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { CONNECTOR_MANIFESTS, SkillSchema } from "../../src/service/connector-manifests.js";
import { validateEnvironment } from "../../src/identity/environment.js";
import { parseRelayConfig } from "../../src/cloud-relay/config.js";
import { parseProduct } from "../../src/service/product-protocol.js";
it("has one typed manifest per connector and keeps command templates separate from shell strings", () => {
  expect(new Set(CONNECTOR_MANIFESTS.map((m) => m.id)).size).toBe(CONNECTOR_MANIFESTS.length);
  for (const m of CONNECTOR_MANIFESTS) {
    expect(m.kind === "local" ? !!m.command : m.id === "Custom HTTP API" || !!m.probe).toBe(true);
  }
  expect(
    SkillSchema.safeParse({
      id: "custom-x",
      name: "X",
      command: "node",
      args: ["-e", "{{script}}"],
      workingDirectory: "../../",
    }).success,
  ).toBe(false);
  expect(parseProduct("projects.syncWorkspaceArtifacts", { files: [".ENVbackup"] })).toBeUndefined();
  expect(parseProduct("projects.syncWorkspaceArtifacts", { files: ["assets/render.mp4"] })).toMatchObject({
    overwrite: false,
  });
});
it("uses one official production host with matching issuer pins and no temporary profiles", async () => {
  const identity = JSON.parse(await readFile("deploy/production/identity.example.json", "utf8"));
  const relay = JSON.parse(await readFile("deploy/production/relay.example.json", "utf8"));
  expect(validateEnvironment(identity, "release")).toMatchObject({
    relayHost: "mcp.crot.network",
    issuer: "https://auth.crot.network",
  });
  expect(parseRelayConfig(relay)).toMatchObject({ relayHost: identity.relayHost, issuer: identity.issuer });
  const files = await readdir("deploy/production");
  expect(files.filter((p) => p.endsWith(".example.json"))).toEqual(["identity.example.json", "relay.example.json"]);
});
