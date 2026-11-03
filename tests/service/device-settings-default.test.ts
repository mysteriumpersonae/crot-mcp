import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import {
  DeviceSettingsStore,
  newInstallRemoteMode,
  REMOTE_MODE_DEFAULT_VARIABLE,
  SERVICE_SETTINGS_FILE_NAME,
} from "../../src/service/device-settings.js";
import { isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

/**
 * Remote mode is on for a new install, so the device tunnel starts with the app. Stored settings keep their value,
 * unreadable state stays fail-closed, and the environment opt-out can only keep a new install off.
 */

const privateFiles = createPrivateFileProtection(isWindows);
let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});
const file = () => path.join(dirs.outside, SERVICE_SETTINGS_FILE_NAME);

describe("remote mode default of a new install", () => {
  it("is on without an opt-out; CROT_REMOTE_MODE_DEFAULT=off (or 0/false/no) keeps it off", () => {
    expect(REMOTE_MODE_DEFAULT_VARIABLE).toBe("CROT_REMOTE_MODE_DEFAULT");
    expect(newInstallRemoteMode({})).toBe(true);
    expect(newInstallRemoteMode({ CROT_REMOTE_MODE_DEFAULT: "" })).toBe(true);
    expect(newInstallRemoteMode({ CROT_REMOTE_MODE_DEFAULT: "on" })).toBe(true);
    for (const value of ["off", "OFF", " 0 ", "false", "no"])
      expect(newInstallRemoteMode({ CROT_REMOTE_MODE_DEFAULT: value })).toBe(false);
  });

  it("a missing settings file applies the default without writing it; turning it off is stored", async () => {
    const store = await DeviceSettingsStore.open(file(), privateFiles, { remoteModeDefault: true });
    expect(store.error).toBeUndefined();
    expect(store.settings).toEqual({ remoteMode: true, remoteFullControl: false });
    await expect(readFile(file(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await store.update({ remoteMode: false });
    const reopened = await DeviceSettingsStore.open(file(), privateFiles, { remoteModeDefault: true });
    expect(reopened.settings.remoteMode).toBe(false);
  });

  it("stored settings keep their value; unreadable state stays fail-closed even with the default on", async () => {
    await writeFile(file(), JSON.stringify({ version: 1, remoteMode: false, remoteFullControl: false }));
    expect((await DeviceSettingsStore.open(file(), privateFiles, { remoteModeDefault: true })).settings).toEqual({
      remoteMode: false,
      remoteFullControl: false,
    });
    await writeFile(file(), "{not json");
    const broken = await DeviceSettingsStore.open(file(), privateFiles, { remoteModeDefault: true });
    expect(broken.error).toMatch(/malformed/);
    expect(broken.settings).toEqual({ preset: "require-approval", remoteMode: false, remoteFullControl: false });
  });

  it("the test suite itself opts out, so test services never reach the relay unless a test turns it on", async () => {
    expect(process.env[REMOTE_MODE_DEFAULT_VARIABLE]).toBe("off");
    expect((await DeviceSettingsStore.open(file(), privateFiles)).settings.remoteMode).toBe(false);
  });
});
