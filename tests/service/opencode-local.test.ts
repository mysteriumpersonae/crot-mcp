/**
 * The owner's local OpenCode: its OpenCode Zen key (OPENCODE_API_KEY, auth.json) and its `opencode` binary
 * (PATH, the install script's and package managers' places, the Windows npm shim).
 */
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authFileCandidates,
  binaryCandidates,
  findOpenCodeBinaries,
  findOpenCodeBinary,
  findOpenCodeKey,
  versionManagerCandidates,
} from "../../src/service/opencode-local.js";
import { makeTempDirs } from "../helpers.js";

const platform = process.platform;

describe("OpenCode Zen key discovery", () => {
  it("looks where OpenCode keeps auth.json, absolute directories only", () => {
    expect(authFileCandidates({ env: { XDG_DATA_HOME: "/xdg" }, home: "/home/u", platform: "linux" })).toEqual([
      "/xdg/opencode/auth.json",
      "/home/u/.local/share/opencode/auth.json",
      "/home/u/.config/opencode/auth.json",
    ]);
    expect(authFileCandidates({ env: { XDG_DATA_HOME: "relative" }, home: "/Users/u", platform: "darwin" })).toEqual([
      "/Users/u/.local/share/opencode/auth.json",
      "/Users/u/.config/opencode/auth.json",
    ]);
    expect(
      authFileCandidates({
        env: { localappdata: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u" },
        home: "C:\\Users\\u",
        platform: "win32",
      }),
    ).toEqual([
      "C:\\Users\\u\\AppData\\Local\\opencode\\auth.json",
      "C:\\Users\\u\\.local\\share\\opencode\\auth.json",
      "C:\\Users\\u\\.config\\opencode\\auth.json",
    ]);
  });

  it("takes OPENCODE_API_KEY first, then an api entry of auth.json; nothing else counts as a key", async () => {
    const dirs = await makeTempDirs();
    try {
      const data = path.join(dirs.outside, "data"),
        home = path.join(dirs.outside, "home"),
        file = path.join(data, "opencode", "auth.json");
      await mkdir(path.dirname(file), { recursive: true });
      await mkdir(home, { recursive: true });
      const local = (env: Record<string, string> = {}) => ({ env: { XDG_DATA_HOME: data, ...env }, home, platform });
      const auth = (value: unknown) => writeFile(file, typeof value === "string" ? value : JSON.stringify(value));

      expect(await findOpenCodeKey(local())).toBeUndefined();
      await auth({ opencode: { type: "api", key: " sk-zen-from-auth-json " } });
      expect(await findOpenCodeKey(local())).toEqual({ key: "sk-zen-from-auth-json", source: "auth.json" });
      expect(await findOpenCodeKey(local({ OPENCODE_API_KEY: "sk-zen-from-env-1" }))).toEqual({
        key: "sk-zen-from-env-1",
        source: "env",
      });
      // A malformed variable does not hide the stored key.
      expect(await findOpenCodeKey(local({ OPENCODE_API_KEY: "short" }))).toMatchObject({ source: "auth.json" });
      await auth({ zen: { type: "api", key: "sk-zen-entry-123" } });
      expect(await findOpenCodeKey(local())).toEqual({ key: "sk-zen-entry-123", source: "auth.json" });
      for (const value of [
        { opencode: { type: "oauth", access: "token-of-another-kind", refresh: "r" } },
        { opencode: { type: "api", key: "has spaces in it" } },
        { opencode: { type: "api", key: "short" } },
        { anthropic: { type: "api", key: "sk-ant-not-for-zen" } },
        "{ not json",
        "[]",
      ]) {
        await auth(value);
        expect(await findOpenCodeKey(local())).toBeUndefined();
      }
      await auth(JSON.stringify({ opencode: { type: "api", key: "sk-zen-too-large-file" }, pad: "x".repeat(300_000) }));
      expect(await findOpenCodeKey(local())).toBeUndefined();

      // ~/.local/share/opencode/auth.json when XDG_DATA_HOME is not set.
      const fallback = path.join(home, ".local", "share", "opencode", "auth.json");
      await mkdir(path.dirname(fallback), { recursive: true });
      await writeFile(fallback, JSON.stringify({ opencode: { type: "api", key: "sk-zen-home-12345" } }));
      expect(await findOpenCodeKey({ env: {}, home, platform })).toEqual({
        key: "sk-zen-home-12345",
        source: "auth.json",
      });
    } finally {
      await dirs.cleanup();
    }
  });
});

describe("OpenCode binary discovery", () => {
  it("lists PATH entries, then the install script's and package managers' places", () => {
    expect(
      binaryCandidates({
        env: { PATH: "/usr/bin:relative::/opt/oc/bin:/usr/bin" },
        home: "/home/u",
        platform: "linux",
      }),
    ).toEqual([
      "/usr/bin/opencode",
      "/opt/oc/bin/opencode",
      "/home/u/.opencode/bin/opencode",
      "/usr/local/bin/opencode",
      "/home/u/.local/bin/opencode",
      "/opt/homebrew/bin/opencode",
      "/home/linuxbrew/.linuxbrew/bin/opencode",
      "/home/u/.bun/bin/opencode",
      "/home/u/.npm-global/bin/opencode",
      "/home/u/.local/share/pnpm/opencode",
      "/home/u/.yarn/bin/opencode",
      "/home/u/.volta/bin/opencode",
    ]);
    expect(
      binaryCandidates({
        env: {
          Path: 'C:\\Windows\\system32;"C:\\Program Files\\nodejs";relative;C:\\Users\\u\\AppData\\Roaming\\npm',
          USERPROFILE: "C:\\Users\\u",
          APPDATA: "C:\\Users\\u\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
          ProgramData: "C:\\ProgramData",
        },
        home: "C:\\Users\\u",
        platform: "win32",
      }),
    ).toEqual([
      "C:\\Windows\\system32\\opencode.exe",
      "C:\\Windows\\system32\\opencode.cmd",
      "C:\\Program Files\\nodejs\\opencode.exe",
      "C:\\Program Files\\nodejs\\opencode.cmd",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.exe",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\opencode.cmd",
      "C:\\Users\\u\\.opencode\\bin\\opencode.exe",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
      "C:\\Users\\u\\.bun\\bin\\opencode.exe",
      "C:\\Users\\u\\AppData\\Local\\pnpm\\opencode.cmd",
      "C:\\Users\\u\\scoop\\apps\\opencode\\current\\opencode.exe",
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.exe",
      "C:\\ProgramData\\chocolatey\\bin\\opencode.exe",
    ]);
  });

  it.skipIf(platform === "win32")(
    "finds the OpenCode of Node version managers, newest Node first, and each program once",
    async () => {
      const dirs = await makeTempDirs();
      try {
        const home = path.join(dirs.outside, "home"),
          data = path.join(dirs.outside, "data");
        const local = { env: { PATH: "", XDG_DATA_HOME: data }, home, platform };
        const program = async (...parts: string[]) => {
          const file = path.join(...parts);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, "#!/bin/sh\nexit 0\n");
          await chmod(file, 0o755);
          return file;
        };
        const nvm = (version: string) => path.join(home, ".nvm", "versions", "node", version, "bin", "opencode");
        for (const version of ["v18.20.0", "v22.11.0", "v22.9.0"]) await program(nvm(version));
        await mkdir(path.join(home, ".nvm", "versions", "node", "system"), { recursive: true });
        const fnm = await program(data, "fnm", "node-versions", "v20.1.0", "installation", "bin", "opencode");
        const mise = await program(data, "mise", "installs", "node", "23.0.0", "bin", "opencode");
        const asdf = await program(home, ".asdf", "installs", "nodejs", "21.7.3", "bin", "opencode");
        expect(await versionManagerCandidates(local)).toEqual([
          nvm("v22.11.0"),
          nvm("v22.9.0"),
          nvm("v18.20.0"),
          fnm,
          mise,
          asdf,
        ]);
        // PATH first; one program behind two names (a link) counts once.
        const links = path.join(dirs.outside, "links");
        await mkdir(links, { recursive: true });
        await symlink(nvm("v22.11.0"), path.join(links, "opencode"));
        const found = await findOpenCodeBinaries({ ...local, env: { ...local.env, PATH: links } });
        expect(found.filter((file) => file.startsWith(dirs.outside))).toEqual([
          path.join(links, "opencode"),
          nvm("v22.9.0"),
          nvm("v18.20.0"),
          fnm,
          mise,
          asdf,
        ]);
      } finally {
        await dirs.cleanup();
      }
    },
  );

  it.skipIf(platform === "win32")("finds an executable opencode on PATH, skipping one that is not", async () => {
    const dirs = await makeTempDirs();
    try {
      const plain = path.join(dirs.outside, "plain"),
        bin = path.join(dirs.outside, "bin");
      await mkdir(plain, { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(plain, "opencode"), "not a program");
      await chmod(path.join(plain, "opencode"), 0o644);
      const local = { env: { PATH: `${plain}:${bin}` }, home: path.join(dirs.outside, "home"), platform };
      const installed = (await findOpenCodeBinary(local)) ?? "";
      // Nothing on this PATH: only a system-wide OpenCode (/usr/local/bin, /opt/homebrew/bin) could be found.
      expect(installed.startsWith(dirs.outside)).toBe(false);
      await writeFile(path.join(bin, "opencode"), "#!/bin/sh\nexit 0\n");
      await chmod(path.join(bin, "opencode"), 0o755);
      expect(await findOpenCodeBinary(local)).toBe(path.join(bin, "opencode"));
    } finally {
      await dirs.cleanup();
    }
  });

  it.runIf(platform === "win32")("resolves the npm shim opencode.cmd to the opencode.exe it starts", async () => {
    const dirs = await makeTempDirs();
    try {
      const npm = path.join(dirs.outside, "npm"),
        exe = path.join(npm, "node_modules", "opencode-ai", "bin", "opencode.exe");
      await mkdir(path.dirname(exe), { recursive: true });
      await writeFile(
        path.join(npm, "opencode.cmd"),
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n',
      );
      const local = { env: { PATH: npm }, home: path.join(dirs.outside, "home"), platform };
      // A shim without its program is not an installation.
      expect(await findOpenCodeBinary(local)).not.toBe(path.join(npm, "opencode.cmd"));
      await writeFile(exe, "MZ");
      expect(await findOpenCodeBinary(local)).toBe(exe);
      // A shim of another layout: the quoted path it starts.
      const other = path.join(dirs.outside, "other"),
        target = path.join(dirs.outside, "pkg", "opencode.exe");
      await mkdir(other, { recursive: true });
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "MZ");
      await writeFile(path.join(other, "opencode.cmd"), `@ECHO off\r\n"${target}" %*\r\n`);
      expect(await findOpenCodeBinary({ ...local, env: { PATH: other } })).toBe(target);
    } finally {
      await dirs.cleanup();
    }
  });
});
