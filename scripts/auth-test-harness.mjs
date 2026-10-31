import { Buffer } from "node:buffer";
/** Isolated test-only bridge. Production preload never exposes HTTP, fixture codes or seeded accounts. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopAuth } from "../dist/desktop-auth/store.js";
import { DesktopAuthController } from "../dist/desktop-auth/controller.js";
export async function authTestHarness({ providers } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "crot-auth-fixture-"));
  const codes = [];
  const auth = await DesktopAuth.open(path.join(dir, "accounts.json"), {
    deliverCode: async (email, code) => {
      codes.push({ email, code });
      return "smtp";
    },
  });
  const r = await auth.register("fixture_user", "fixture@example.test", "fixture-password-123");
  await auth.verify(r.challengeId, codes.at(-1).code);
  auth.logout();
  const controller = new DesktopAuthController(auth, {}, async () => {
    throw Error("Live OAuth forbidden in test");
  });
  return {
    codes,
    auth,
    controller,
    shim: "auth:async(method,input={})=>{const r=await fetch('/_test-auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})});return r.json();},",
    async handle(req, res, pathname) {
      if (pathname !== "/_test-auth") return false;
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return true;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096) throw Error("auth fixture limit");
      }
      const { method, input } = JSON.parse(raw);
      res
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(
          JSON.stringify(
            method.startsWith("providers-")
              ? providers
                ? await providers.call(method, input)
                : { ok: true, configured: true }
              : await controller.call(method, input),
          ),
        );
      return true;
    },
    async close() {
      controller.cancel();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
