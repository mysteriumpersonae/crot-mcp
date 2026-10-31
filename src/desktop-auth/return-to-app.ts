/** Short-lived, single-use window activation capability. Never carries auth data. */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
export async function createAppReturn(origin: string, activate: () => boolean) {
  const capability = randomBytes(32).toString("base64url");
  let used = false;
  const server = createServer((req, res) => {
    const local = req.socket.localPort;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    if (
      used ||
      req.method !== "POST" ||
      req.url !== "/continue/" + capability ||
      req.headers.host !== `127.0.0.1:${local}` ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.origin !== origin
    ) {
      res.writeHead(403).end("Return link unavailable. Switch to CROT using your taskbar or Dock.");
      return;
    }
    res.setHeader("access-control-allow-origin", origin);
    used = true;
    let activated = false;
    try {
      activated = activate();
    } catch {
      /* Window may have closed during return. */
    }
    res.writeHead(activated ? 204 : 410).end();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  };
  const timer = setTimeout(close, 120_000);
  timer.unref();
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/continue/${capability}`, close };
}
