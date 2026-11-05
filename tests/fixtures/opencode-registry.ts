/**
 * A local stand-in for the npm registry of CROT's one-click OpenCode install: platform packages as npm packs
 * them (gzipped tar, `package/...`, a pax header for a long name) at /<name>/-/<name>-<version>.tgz, with
 * their sha512 (SRI) for the runtime's pinned integrity.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { gzipSync } from "node:zlib";

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
function header(name: string, size: number, type: string, mode = 0o644): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(mode, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(type, 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}
const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
/** A .tgz of `files` (path → content); names over 100 bytes get a pax `path` record first. */
export function tgz(files: Readonly<Record<string, string | Buffer>>, modes: Readonly<Record<string, number>> = {}) {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    if (Buffer.byteLength(name) > 100) {
      const body = (n: number) => `${n} path=${name}\n`;
      let length = body(0).length;
      while (body(length).length !== length) length = body(length).length;
      const record = Buffer.from(body(length));
      parts.push(header("PaxHeader/long", record.length, "x"), pad(record));
    }
    parts.push(header(name, data.length, "0", modes[name]), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
export const integrityOf = (data: Buffer): string => `sha512-${createHash("sha512").update(data).digest("base64")}`;

/** The registry: serves `packages` (name → .tgz), holding every answer until `gate` resolves. */
export async function fakeRegistry(packages: Readonly<Record<string, Buffer>>, gate?: Promise<void>) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    void (async () => {
      await gate;
      const name = /^\/([\w.-]+)\/-\/\1-\d+\.\d+\.\d+\.tgz$/.exec(req.url ?? "")?.[1];
      const body = name ? packages[name] : undefined;
      if (!body) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length }).end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    seen,
    integrity: Object.fromEntries(Object.entries(packages).map(([name, data]) => [name, integrityOf(data)])),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
