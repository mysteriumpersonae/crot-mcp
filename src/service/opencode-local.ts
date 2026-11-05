/**
 * The owner's local OpenCode installation (https://opencode.ai): its stored OpenCode Zen key and its
 * `opencode` binary. Read-only discovery. A found key is used only for requests to OpenCode Zen; it is
 * never logged, persisted, returned to the UI or passed to a child process.
 */
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
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
 * usual package-manager directories (Homebrew, Bun, npm's prefix, pnpm, Yarn, Volta, Scoop, WinGet,
 * Chocolatey). A program started from the desktop often gets a short PATH without the owner's shell setup, so
 * these places are searched as well. On Windows an npm shim (opencode.cmd) stands for the binary it starts.
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
  const under = (dir: string | undefined, ...parts: string[]) => (dir ? add(p.join(dir, ...parts)) : undefined);
  if (windows) {
    const profile = variable(local, "USERPROFILE") ?? local.home;
    const appData = variable(local, "APPDATA"),
      localAppData = variable(local, "LOCALAPPDATA");
    under(profile, ".opencode", "bin", "opencode.exe");
    under(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    under(variable(local, "NPM_CONFIG_PREFIX"), "opencode.cmd");
    under(variable(local, "NVM_SYMLINK"), "opencode.cmd");
    under(variable(local, "PROGRAMFILES"), "nodejs", "opencode.cmd");
    under(profile, ".bun", "bin", "opencode.exe");
    under(variable(local, "PNPM_HOME"), "opencode.cmd");
    under(localAppData, "pnpm", "opencode.cmd");
    under(
      variable(local, "SCOOP") ?? (profile ? p.join(profile, "scoop") : undefined),
      "apps",
      "opencode",
      "current",
      "opencode.exe",
    );
    under(localAppData, "Microsoft", "WinGet", "Links", "opencode.exe");
    under(variable(local, "PROGRAMDATA"), "chocolatey", "bin", "opencode.exe");
  } else {
    const home = local.home || undefined;
    under(home, ".opencode", "bin", "opencode");
    add("/usr/local/bin/opencode");
    under(home, ".local", "bin", "opencode");
    add("/opt/homebrew/bin/opencode");
    add("/home/linuxbrew/.linuxbrew/bin/opencode");
    under(variable(local, "BUN_INSTALL") ?? (home ? p.join(home, ".bun") : undefined), "bin", "opencode");
    under(variable(local, "NPM_CONFIG_PREFIX"), "bin", "opencode");
    under(home, ".npm-global", "bin", "opencode");
    under(variable(local, "PNPM_HOME"), "opencode");
    under(home, local.platform === "darwin" ? "Library/pnpm" : ".local/share/pnpm", "opencode");
    under(home, ".yarn", "bin", "opencode");
    under(variable(local, "VOLTA_HOME") ?? (home ? p.join(home, ".volta") : undefined), "bin", "opencode");
    add("/usr/bin/opencode");
  }
  return out;
}

/** Version directories of a Node.js version manager ("v22.11.0", "22.11.0"), newest first. */
const NODE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAX_NODE_VERSIONS = 16;
function newestFirst(a: string, b: string): number {
  const x = NODE_VERSION.exec(a)!.slice(1).map(Number),
    y = NODE_VERSION.exec(b)!.slice(1).map(Number);
  return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
}

/**
 * Node.js version managers keep each Node version's global npm packages (`npm i -g opencode-ai`) in that
 * version's own folder, which only the owner's shell puts on PATH: nvm, fnm, mise, asdf (nvm-windows and fnm
 * on Windows). Their `opencode`, newest Node version first.
 */
export async function versionManagerCandidates(local: OpenCodeLocal): Promise<string[]> {
  const p = paths(local),
    windows = local.platform === "win32",
    home = local.home || undefined,
    dataHome = variable(local, "XDG_DATA_HOME") ?? (home ? p.join(home, ".local", "share") : undefined);
  const join = (dir: string | undefined, ...parts: string[]) => (dir ? p.join(dir, ...parts) : undefined);
  // [folder of the versions, path inside one version]
  const managers: [string | undefined, string[]][] = windows
    ? [
        [
          join(variable(local, "FNM_DIR") ?? join(variable(local, "APPDATA"), "fnm"), "node-versions"),
          ["installation", "opencode.cmd"],
        ],
        [variable(local, "NVM_HOME") ?? join(variable(local, "APPDATA"), "nvm"), ["opencode.cmd"]],
      ]
    : [
        [join(variable(local, "NVM_DIR") ?? join(home, ".nvm"), "versions", "node"), ["bin", "opencode"]],
        ...[
          variable(local, "FNM_DIR"),
          join(dataHome, "fnm"),
          local.platform === "darwin" ? join(home, "Library", "Application Support", "fnm") : undefined,
          join(home, ".fnm"),
        ].map((dir): [string | undefined, string[]] => [
          join(dir, "node-versions"),
          ["installation", "bin", "opencode"],
        ]),
        [join(variable(local, "MISE_DATA_DIR") ?? join(dataHome, "mise"), "installs", "node"), ["bin", "opencode"]],
        [join(variable(local, "ASDF_DATA_DIR") ?? join(home, ".asdf"), "installs", "nodejs"), ["bin", "opencode"]],
      ];
  const out: string[] = [];
  for (const [dir, inside] of managers) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const versions = await readdir(dir).catch(() => [] as string[]);
    for (const version of versions
      .filter((v) => NODE_VERSION.test(v))
      .sort(newestFirst)
      .slice(0, MAX_NODE_VERSIONS)) {
      const file = p.join(dir, version, ...inside);
      if (!out.includes(file)) out.push(file);
    }
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

/** The program a candidate stands for (an npm shim: the binary it starts), or undefined when it is none. */
async function program(local: OpenCodeLocal, candidate: string): Promise<string | undefined> {
  if (!(await isFile(candidate))) return undefined;
  if (local.platform === "win32") return /\.cmd$/i.test(candidate) ? shimTarget(local, candidate) : candidate;
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined; // Not executable for this user.
  }
}

/** Every place searched for the owner's `opencode`, in order: PATH, the usual install places, Node version managers. */
export async function openCodeCandidates(local: OpenCodeLocal): Promise<string[]> {
  const out = binaryCandidates(local);
  for (const file of await versionManagerCandidates(local)) if (!out.includes(file)) out.push(file);
  return out;
}

/**
 * Every `opencode` binary of the owner, in the order to try them (PATH first): one entry per program, so a
 * symlink and its target, or two PATH entries of one folder, count once. An old or broken one does not hide a
 * working one in another place.
 */
export async function findOpenCodeBinaries(local: OpenCodeLocal): Promise<string[]> {
  const out: string[] = [],
    seen = new Set<string>();
  for (const candidate of await openCodeCandidates(local)) {
    const file = await program(local, candidate);
    if (!file) continue;
    const real = await realpath(file).catch(() => file);
    const id = local.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(file);
  }
  return out;
}

/** The absolute path of the owner's `opencode` binary, or undefined when OpenCode is not installed. */
export async function findOpenCodeBinary(local: OpenCodeLocal): Promise<string | undefined> {
  for (const candidate of await openCodeCandidates(local)) {
    const file = await program(local, candidate);
    if (file) return file;
  }
  return undefined;
}
