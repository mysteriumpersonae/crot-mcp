import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "./tests/browser-files-reporter.ts"],
    ...(process.platform === "darwin"
      ? {
          reporters: [
            "default",
            "./tests/browser-files-reporter.ts",
            ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
            "./tests/macos-l1-reporter.ts",
          ],
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          // Native qualification changes real shared ancestor descriptors.
          // Run files serially; production has its own durable machine owner.
          fileParallelism: false,
          reporters: [
            "default",
            "./tests/browser-files-reporter.ts",
            ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
            "./tests/stage6a-reporter.ts",
          ],
        }
      : {}),
    include: ["tests/**/*.test.ts"],
    // New installs turn remote mode on (the device tunnel then reaches the relay); test services stay offline
    // unless a test turns remote mode on itself. tests/service/device-settings-default.test.ts covers the default.
    env: { CROT_REMOTE_MODE_DEFAULT: "off" },
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
