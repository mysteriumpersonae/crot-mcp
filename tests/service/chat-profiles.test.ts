import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { ProductRuntime } from "../../src/service/product-runtime.js";
import type { ChatProviderConfig } from "../../src/service/chat-runtime.js";
import { createTestCore, makeTempDirs } from "../helpers.js";

interface Listed {
  provider: string;
  base: string;
  displayName?: string;
  endpoint: string;
  configured: boolean;
  credentialStored: boolean;
  connectionStatus?: string;
  connectionError?: unknown;
}
interface Internals {
  state: { chatProviders?: Record<string, ChatProviderConfig> };
  vault: { credentials: Record<string, string> };
  persist(): Promise<void>;
}

async function setup() {
  const dirs = await makeTempDirs();
  const stateDir = path.join(dirs.outside, "state");
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
  const cores: CrotCore[] = [];
  const open = async () => {
    const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    cores.push(core);
    return ProductRuntime.open({
      stateDir,
      privateFiles,
      secrets: store,
      core: () => core,
      selectWorkspace: async () => {},
      recordControlEvent: async () => {},
    });
  };
  const cleanup = async () => {
    for (const core of cores) await core.shutdown();
    await dirs.cleanup();
  };
  return { open, cleanup };
}
const listed = async (runtime: ProductRuntime) => (await runtime.request("chat.providers", {})).providers as Listed[];

describe("custom chat provider profiles", () => {
  it("keeps every custom server as its own profile and removes only the chosen one", async () => {
    const { open, cleanup } = await setup();
    let runtime = await open();
    try {
      const river = await runtime.request("chat.configure", {
        provider: "Custom API",
        endpoint: "https://api.river.ai/v1",
        credential: "river-key",
      });
      expect(river.provider).toBe("Custom API:river");
      const second = await runtime.request("chat.configure", {
        provider: "Custom API",
        endpoint: "https://llm.example.com/v1",
        credential: "second-key",
      });
      expect(second.provider).toBe("Custom API:llm");
      // The same server again updates its profile instead of adding a third one.
      expect(
        (
          await runtime.request("chat.configure", {
            provider: "Custom API",
            endpoint: "https://api.river.ai/v1",
            credential: "river-key-2",
          })
        ).provider,
      ).toBe("Custom API:river");
      const profiles = (await listed(runtime)).filter((p) => p.provider.startsWith("Custom API:"));
      expect(profiles).toEqual([
        expect.objectContaining({
          provider: "Custom API:river",
          base: "Custom API",
          displayName: "River",
          endpoint: "https://api.river.ai/v1",
          credentialStored: true,
        }),
        expect.objectContaining({ provider: "Custom API:llm", displayName: "Llm", credentialStored: true }),
      ]);
      // The bare family still lists as an unconfigured template for adding another server.
      expect((await listed(runtime)).find((p) => p.provider === "Custom API")).toMatchObject({ configured: false });
      // With two servers a bare family key is ambiguous.
      await expect(runtime.request("chat.models", { provider: "Custom API" })).rejects.toThrow(/Choose which/);
      await runtime.request("chat.remove", { provider: "Custom API:llm" });
      expect((await listed(runtime)).map((p) => p.provider)).not.toContain("Custom API:llm");
      await runtime.close();
      runtime = await open();
      expect((await listed(runtime)).find((p) => p.provider === "Custom API:river")).toMatchObject({
        displayName: "River",
        credentialStored: true,
      });
      // A profile key edits that profile in place, label included.
      expect(
        (await runtime.request("chat.configure", { provider: "Custom API:river", label: "River prod" })).provider,
      ).toBe("Custom API:river");
      expect((await listed(runtime)).find((p) => p.provider === "Custom API:river")?.displayName).toBe("River prod");
    } finally {
      await runtime.close();
      await cleanup();
    }
  });

  it("moves legacy single custom configurations to profiles with their credentials and keeps other entries", async () => {
    const { open, cleanup } = await setup();
    let runtime = await open();
    try {
      const internals = runtime as unknown as Internals;
      internals.state.chatProviders = {
        "Custom API": { endpoint: "https://api.river.ai/v1", defaultModel: "river-large" },
        River: { endpoint: "" },
        Bogus: { endpoint: "https://bogus.example.com" },
      };
      internals.vault.credentials["chat:Custom API"] = "legacy-custom-key";
      internals.vault.credentials["chat:River"] = "legacy-river-key";
      await internals.persist();
      await runtime.close();
      runtime = await open();
      const after = runtime as unknown as Internals;
      expect(Object.keys(after.state.chatProviders ?? {}).sort()).toEqual([
        "Bogus",
        "Custom API:river",
        "OpenAI-compatible:river",
      ]);
      expect(after.vault.credentials["chat:Custom API:river"]).toBe("legacy-custom-key");
      expect(after.vault.credentials["chat:OpenAI-compatible:river"]).toBe("legacy-river-key");
      expect(after.vault.credentials["chat:Custom API"]).toBeUndefined();
      const providers = await listed(runtime);
      expect(providers.find((p) => p.provider === "Custom API:river")).toMatchObject({
        displayName: "River",
        endpoint: "https://api.river.ai/v1",
        credentialStored: true,
      });
      expect(providers.find((p) => p.provider === "OpenAI-compatible:river")).toMatchObject({
        displayName: "River 2",
        endpoint: "https://api.river.ai/v1",
      });
      // Unknown saved keys are left alone and never listed.
      expect(providers.map((p) => p.provider)).not.toContain("Bogus");
    } finally {
      await runtime.close();
      await cleanup();
    }
  });

  it("hides a stale status and error for a provider whose required credential is missing", async () => {
    const { open, cleanup } = await setup();
    const runtime = await open();
    try {
      await runtime.request("chat.configure", { provider: "OpenAI" });
      expect(await runtime.request("chat.testConnection", { provider: "OpenAI" })).toMatchObject({ ok: false });
      const openai = (await listed(runtime)).find((p) => p.provider === "OpenAI");
      expect(openai).toMatchObject({ configured: true, credentialStored: false });
      expect(openai?.connectionStatus).toBeUndefined();
      expect(openai?.connectionError).toBeUndefined();
    } finally {
      await runtime.close();
      await cleanup();
    }
  });
});
