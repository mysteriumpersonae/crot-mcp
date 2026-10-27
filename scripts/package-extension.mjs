/** Reproducible, dependency-free Chrome/Edge MV3 store archive (WP-35). */
import { validateOutput } from "./output-path.mjs";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PERMISSIONS = [
  "alarms",
  "debugger",
  "downloads",
  "nativeMessaging",
  "scripting",
  "tabGroups",
  "tabs",
  "webNavigation",
];
const STORE_FIELDS = new Set([
  "manifest_version",
  "name",
  "version",
  "description",
  "key",
  "minimum_chrome_version",
  "incognito",
  "background",
  "permissions",
  "host_permissions",
  "action",
  "icons",
  "content_security_policy",
]);
const ICONS = Object.fromEntries([16, 32, 48, 128].map((size) => [String(size), `icons/icon${size}.png`]));
const MODULES = [
  ...[
    "background",
    "browser-info",
    "cdp",
    "chrome-api",
    "commands",
    "control",
    "delivery",
    "download-capture",
    "download-ownership",
    "errors",
    "frames",
    "host-connection",
    "input",
    "owner-ui",
    "page-functions",
    "refs",
    "snapshot",
  ].map((name) => `dist/extension/src/${name}.js`),
  "dist/src/browser-bridge/protocol.js",
  "dist/src/core/capabilities/browser/connection.js",
  "dist/src/core/capabilities/browser/schemas.js",
  "dist/src/core/capabilities/browser/tab-policy.js",
  "dist/src/core/publications/browser-boundary.js",
].sort();
const FORBIDDEN_FIELDS = ["content_scripts", "externally_connectable", "web_accessible_resources", "update_url"];
export function validateStoreManifest(manifest) {
  for (const field of Object.keys(manifest))
    if (!STORE_FIELDS.has(field)) throw new Error(`unreviewed store manifest field: ${field}`);
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version ?? "")) throw new Error("invalid store version");
  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none'; base-uri 'none'")
    throw new Error("store CSP must forbid remote code and evaluation");
  const sameIcons = (icons) =>
    icons && Object.keys(icons).length === 4 && Object.entries(ICONS).every(([size, name]) => icons[size] === name);
  if (
    !sameIcons(manifest.icons) ||
    !sameIcons(manifest.action?.default_icon) ||
    manifest.action?.default_popup !== "popup.html"
  )
    throw new Error("store action and 16/32/48/128 icons must match reviewed paths");
  if (manifest.background?.service_worker !== "dist/extension/src/background.js")
    throw new Error("unreviewed service worker");
  if (manifest.manifest_version !== 3) throw new Error("store manifest must be MV3");
  const permissions = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(REQUIRED_PERMISSIONS))
    throw new Error(`store permissions must be exactly: ${REQUIRED_PERMISSIONS.join(", ")}`);
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["<all_urls>"]))
    throw new Error('host_permissions must be exactly ["<all_urls>"]');
  if (manifest.incognito !== "not_allowed") throw new Error('incognito must be "not_allowed"');
  for (const field of FORBIDDEN_FIELDS)
    if (field in manifest) throw new Error(`forbidden store manifest field: ${field}`);
  if (
    !manifest.background ||
    manifest.background.type !== "module" ||
    typeof manifest.background.service_worker !== "string"
  )
    throw new Error("MV3 module service worker is required");
  return manifest;
}
let crcTable;
function crc32(bytes) {
  if (!crcTable)
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    local.push(header, data);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(0x0314),
        u16(20),
        u16(0x800),
        u16(0),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0o100644 << 16),
        u32(offset),
        name,
      ]),
    );
    offset += header.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
}
async function files(root, prefix = "") {
  const out = [];
  for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await files(path.join(root, item.name), relative)));
    else if (item.isFile()) out.push({ name: relative, data: await readFile(path.join(root, item.name)) });
    else throw new Error(`nonregular extension artifact: ${relative}`);
  }
  return out;
}
export async function packageExtension({
  repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  outDir = process.env.CROT_EXTENSION_OUT
    ? path.resolve(process.env.CROT_EXTENSION_OUT)
    : path.join(repo, "artifacts", "extension"),
} = {}) {
  outDir = await validateOutput(repo, outDir);
  for (const name of ["extension", "extension/manifest.json"])
    if ((await lstat(path.join(repo, name))).isSymbolicLink()) throw new Error("extension artifact symlink refused");
  const manifest = validateStoreManifest(
    JSON.parse(await readFile(path.join(repo, "extension", "manifest.json"), "utf8")),
  );
  const dist = path.join(repo, "extension", "dist");
  const compiled = await files(dist, "dist");
  if (JSON.stringify(compiled.map((entry) => entry.name).sort()) !== JSON.stringify(MODULES))
    throw new Error(
      "extension/dist must contain exactly the reviewed production modules; remove stale/dev/test artifacts and rebuild",
    );
  const icons = await Promise.all(
    Object.entries(ICONS).map(async ([size, name]) => {
      const data = await readFile(path.join(repo, "extension", name));
      if (
        data.length < 33 ||
        !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        data.toString("ascii", 12, 16) !== "IHDR" ||
        data.readUInt32BE(16) !== Number(size) ||
        data.readUInt32BE(20) !== Number(size)
      )
        throw new Error(`invalid store icon dimensions: ${name}`);
      return { name, data };
    }),
  );
  const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
    ...compiled,
    ...(await Promise.all(
      [
        "popup-geometry.css",
        "i18n.js",
        "welcome.js",
        "popup.html",
        "popup.js",
        "welcome.html",
        "ui.css",
        "popup.css",
      ].map(async (name) => ({
        name,
        data: await readFile(path.join(repo, "extension", name)),
      })),
    )),
    ...icons,
  ];
  if (entries.length < 2) throw new Error("extension/dist is empty; run npm run build:extension");
  for (const entry of entries) {
    if (entry.name === "manifest.json") continue;
    const parts = entry.name.split("/");
    for (let n = 1; n <= parts.length; n++)
      if ((await lstat(path.join(repo, "extension", ...parts.slice(0, n)))).isSymbolicLink())
        throw new Error("extension artifact symlink refused");
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const archive = zip(entries);
  const digest = createHash("sha256").update(archive).digest("hex");
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, `crot-browser-extension-${manifest.version}.zip`);
  await rm(target, { force: true });
  await writeFile(target, archive);
  await writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
  return { target, digest, files: entries.map((e) => e.name) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packageExtension();
  process.stdout.write(`${result.target}\nSHA256 ${result.digest}\n`);
}
