/** Owner-requested local diagnostics. No shell or environment/credential dump. */
import { createServer } from "node:net";
export async function checkLoopbackPort(): Promise<{ status: string; port?: number; detail: string }> {
  const server = createServer();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.close();
      resolve({ status: "unavailable", detail: "Loopback bind timed out" });
    }, 2000);
    timer.unref();
    server.once("error", () => {
      clearTimeout(timer);
      resolve({ status: "unavailable", detail: "Loopback bind refused" });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address(),
        port = typeof a === "object" && a ? a.port : undefined;
      server.close(() => {
        clearTimeout(timer);
        resolve({
          status: "available",
          port,
          detail: "Ephemeral loopback port bound and released; fixed production port availability not implied",
        });
      });
    });
  });
}
