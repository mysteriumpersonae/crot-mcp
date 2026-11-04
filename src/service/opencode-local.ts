/**
 * The owner's local OpenCode installation (https://opencode.ai): its stored OpenCode Zen key and its
 * `opencode` binary. Read-only discovery. A found key is used only for requests to OpenCode Zen; it is
 * never logged, persisted, returned to the UI or passed to a child process.
 */
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createEnvironmentPolicy } from "../core/platform/environment.js";

/** Where to look: the host environment (PATH, OPENCODE_API_KEY, XDG_DATA_HOME, LOCALAPPDATA, ...), home and OS. */
export interface OpenCodeLocal {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}
export type OpenCodeKeySource = "env" | "auth.json";
export interface OpenCodeKey {
  readonly key: string;
  readonly source: OpenCodeKeySource;
}

/** API keys are printable ASCII without spaces (OpenCode Zen: "sk-…"). */
const KEY = /^[\x21-\x7e]{8,512}$/;
const MAX_AUTH_BYTES = 256 * 1024;
const MAX_SHIM_BYTES = 16 * 1024;
/** auth.json entries that hold an OpenCode Zen key ({ "type": "api", "key": "…" }). */
const AUTH_ENTRIES = ["opencode", "zen", "console"] as const;

const paths = (local: OpenCodeLocal) => (local.platform === "win32" ? path.win32 : path.posix);
const variable = (local: OpenCodeLocal, name: string): string | undefined =>
  createEnvironmentPolicy(local.platform === "win32")
    .get(local.env, name)
    ?.trim() || undefined;

/**
 * OpenCode's credential file in the order OpenCode itself uses it: $XDG_DATA_HOME/opencode/auth.json, then
 * ~/.local/share/opencode/auth.json (all systems; on Windows also %LOCALAPPDATA% and %USERPROFILE%), then
 * ~/.config/opencode/auth.json. Absolute directories only.
 */
export function authFileCandidates(local: OpenCodeLocal): string[] {
  const p = paths(local),
    out: string[] = [];
  const add = (dir: string | undefined) => {
    if (!dir || !p.isAbsolute(dir)) return;
    const file = p.join(dir, "opencode", "auth.json");
    if (!out.includes(file)) out.push(file);
  };
  add(variable(local, "XDG_DATA_HOME"));
  if (local.platform === "win32") {
    add(variable(local, "LOCALAPPDATA"));
    const profile = variable(local, "USERPROFILE");
    if (profile) add(p.join(profile, ".local", "share"));
  }
  if (local.home) {
    add(p.join(local.home, ".local", "share"));
    add(p.join(local.home, ".config"));
  }
  return out;
}

async function authFileKey(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_AUTH_BYTES) return undefined;
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!data || typeof data !== "object") return undefined;
    for (const name of AUTH_ENTRIES) {
      const entry = (data as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
      const key = entry?.type === "api" && typeof entry.key === "string" ? entry.key.trim() : "";
      if (KEY.test(key)) return key;
    }
  } catch {
    // Missing, unreadable or malformed: no key from this file.
  }
  return undefined;
}

/** The owner's OpenCode Zen key: OPENCODE_API_KEY first, then OpenCode's auth.json (type "api" entries). */
export async function findOpenCodeKey(local: OpenCodeLocal): Promise<OpenCodeKey | undefined> {
  const fromEnv = variable(local, "OPENCODE_API_KEY");
  if (fromEnv && KEY.test(fromEnv)) return { key: fromEnv, source: "env" };
  for (const file of authFileCandidates(local)) {
    const key = await authFileKey(file);
    if (key) return { key, source: "auth.json" };
  }
  return undefined;
}

/**
 * Places of the `opencode` binary: absolute PATH entries, then the install script's ~/.opencode/bin and the
 * usual package-manager directories. On Windows an npm shim (opencode.cmd) stands for the binary it starts.
 */
export function binaryCandidates(local: OpenCodeLocal): string[] {
  const p = paths(local),
    windows = local.platform === "win32",
    out: string[] = [];
  const add = (file: string | undefined) => {
    if (file && p.isAbsolute(file) && !out.includes(file)) out.push(file);
  };
  for (const raw of (variable(local, "PATH") ?? "").split(windows ? ";" : ":")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !p.isAbsolute(dir)) continue;
    if (windows) {
      add(p.join(dir, "opencode.exe"));
      add(p.join(dir, "opencode.cmd"));
    } else add(p.join(dir, "opencode"));
  }
  if (windows) {
    const profile = variable(local, "USERPROFILE") ?? local.home;
    if (profile) add(p.join(profile, ".opencode", "bin", "opencode.exe"));
    const appData = variable(local, "APPDATA");
    if (appData) add(p.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
  } else {
    if (local.home) add(p.join(local.home, ".opencode", "bin", "opencode"));
    add("/usr/local/bin/opencode");
    if (local.home) add(p.join(local.home, ".local", "bin", "opencode"));
    add("/opt/homebrew/bin/opencode");
  }
  return out;
}

const isFile = async (file: string): Promise<boolean> => (await stat(file).catch(() => undefined))?.isFile() ?? false;

/** The binary an npm/pnpm shim (opencode.cmd) starts: its own package's bin/opencode.exe. */
async function shimTarget(local: OpenCodeLocal, shim: string): Promise<string | undefined> {
  const p = paths(local),
    dir = p.dirname(shim);
  const sibling = p.join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (await isFile(sibling)) return sibling;
  try {
    const info = await stat(shim);
    if (!info.isFile() || info.size > MAX_SHIM_BYTES) return undefined;
    const target = /"([^"\r\n]*opencode\.exe)"/i.exec(await readFile(shim, "utf8"))?.[1];
    const file = target?.replace(/^%~?dp0%?\\?/i, `${dir}\\`);
    return file && p.isAbsolute(file) && (await isFile(file)) ? p.normalize(file) : undefined;
  } catch {
    return undefined;
  }
}

/** The absolute path of the owner's `opencode` binary, or undefined when OpenCode is not installed. */
export async function findOpenCodeBinary(local: OpenCodeLocal): Promise<string | undefined> {
  for (const candidate of binaryCandidates(local)) {
    if (local.platform === "win32") {
      if (/\.cmd$/i.test(candidate)) {
        if (await isFile(candidate)) {
          const target = await shimTarget(local, candidate);
          if (target) return target;
        }
      } else if (await isFile(candidate)) return candidate;
      continue;
    }
    if (!(await isFile(candidate))) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable for this user.
    }
  }
  return undefined;
}
