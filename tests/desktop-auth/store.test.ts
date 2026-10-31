import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopAuth } from "../../src/desktop-auth/store.js";
import { DesktopAuthController } from "../../src/desktop-auth/controller.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-login-"));
  dirs.push(dir);
  let time = 1000000;
  const delivered: { email: string; code: string }[] = [];
  const file = path.join(dir, "accounts.json");
  const options = {
    now: () => time,
    deliverCode: async (email: string, code: string) => {
      delivered.push({ email, code });
      return "smtp" as const;
    },
  };
  const auth = await DesktopAuth.open(file, options);
  return {
    auth,
    file,
    options,
    delivered,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe("Screen 01 durable real authentication", () => {
  it("rejects empty/invalid accounts and non-existing/wrong-password logins without a session", async () => {
    const f = await fixture();
    await expect(f.auth.register("ab", "bad", "123")).rejects.toThrow("INVALID_REGISTRATION");
    await expect(f.auth.login("nobody", "not-a-password")).rejects.toThrow("INVALID_CREDENTIALS");
    const r = await f.auth.register("Astin", "person@example.test", "long-password");
    expect(r).toMatchObject({ step: "verify", authenticated: false, retryAfter: 60 });
    expect(f.auth.status().authenticated).toBe(false);
    await expect(f.auth.login("Astin", "wrong-password")).rejects.toThrow("INVALID_CREDENTIALS");
    expect(f.auth.status().authenticated).toBe(false);
    const db = await readFile(f.file, "utf8");
    expect(db).not.toContain("long-password");
    expect(db).not.toContain(f.delivered[0]!.code);
    expect(db).toContain("pending_verification");
  });
  it("activates only on a correct unexpired one-use code; supports real username/email login after restart", async () => {
    const f = await fixture(),
      r = await f.auth.register("Astin", "PERSON@example.test", "long-password");
    const wrong = f.delivered[0]!.code === "000000" ? "111111" : "000000";
    await expect(f.auth.verify(r.challengeId, wrong)).rejects.toThrow("INVALID_CODE");
    expect(f.auth.status().authenticated).toBe(false);
    expect(await f.auth.verify(r.challengeId, f.delivered[0]!.code)).toMatchObject({
      authenticated: true,
      profile: { login: "Astin", email: "person@example.test" },
    });
    await expect(f.auth.verify(r.challengeId, f.delivered[0]!.code)).rejects.toThrow("INVALID_CODE");
    f.auth.logout();
    await expect(f.auth.login("Astin", "wrong-password")).rejects.toThrow("INVALID_CREDENTIALS");
    expect((await f.auth.login("astin", "long-password")).authenticated).toBe(true);
    const reopened = await DesktopAuth.open(f.file, f.options);
    expect(reopened.status().authenticated).toBe(false);
    expect((await reopened.login("PERSON@example.test", "long-password")).authenticated).toBe(true);
    f.advance(12 * 3600000 + 1);
    expect(reopened.status().authenticated).toBe(false);
  });
  it("atomically rejects duplicate login/email and serializes concurrent registrations", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      f.auth.register("Astin", "one@example.test", "long-password"),
      f.auth.register("ASTIN", "two@example.test", "long-password"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(f.auth.register("other", "ONE@example.test", "long-password")).rejects.toThrow("EMAIL_TAKEN");
  });
  it("expires OTP at ten minutes, enforces resend cooldown and invalidates old codes", async () => {
    const f = await fixture(),
      r = await f.auth.register("Astin", "one@example.test", "long-password");
    await expect(f.auth.resend(r.challengeId)).rejects.toThrow("RESEND_WAIT");
    f.advance(600001);
    await expect(f.auth.verify(r.challengeId, f.delivered[0]!.code)).rejects.toThrow("INVALID_CODE");
    const next = await f.auth.resend(r.challengeId);
    expect(next.challengeId).not.toBe(r.challengeId);
    await expect(f.auth.verify(r.challengeId, f.delivered[0]!.code)).rejects.toThrow("INVALID_CODE");
    expect((await f.auth.verify(next.challengeId, f.delivered[1]!.code)).authenticated).toBe(true);
  });
  it("limits code guesses and sends a fresh code for an unverified login after cooldown", async () => {
    const f = await fixture(),
      r = await f.auth.register("Astin", "one@example.test", "long-password");
    const wrong = f.delivered[0]!.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(f.auth.verify(r.challengeId, wrong)).rejects.toThrow("INVALID_CODE");
    await expect(f.auth.verify(r.challengeId, f.delivered[0]!.code)).rejects.toThrow("INVALID_CODE");
    f.advance(60001);
    const next = await f.auth.login("Astin", "long-password");
    expect(next.step).toBe("verify");
    expect(f.delivered).toHaveLength(2);
    expect(f.auth.status().authenticated).toBe(false);
  });
  it("does not activate or retain usable OTP on mail failure", async () => {
    const f = await fixture();
    f.options.deliverCode = async () => {
      throw Error("SMTP secret must not reach renderer");
    };
    await expect(f.auth.register("Astin", "one@example.test", "long-password")).rejects.toThrow(
      "EMAIL_DELIVERY_FAILED",
    );
    expect(f.auth.status().authenticated).toBe(false);
    expect(JSON.parse(await readFile(f.file, "utf8")).users[0].challenge).toBeUndefined();
  });
  it("provider accounts require verified profiles and never auto-link to an existing email", async () => {
    const f = await fixture();
    await f.auth.register("Astin", "one@example.test", "long-password");
    await expect(
      f.auth.acceptProvider("google", { subject: "123", email: "one@example.test", login: "Astin" }),
    ).rejects.toThrow("ACCOUNT_LINK_REQUIRED");
    expect(
      (await f.auth.acceptProvider("github", { subject: "123", email: "verified@example.test", login: "Astin" }))
        .authenticated,
    ).toBe(true);
    const data = JSON.parse(await readFile(f.file, "utf8"));
    expect(data.users).toHaveLength(2);
    expect(data.users[1].login).not.toBe("Astin");
  });
  it("rejects symlink/private-file permission hazards", async () => {
    const f = await fixture();
    await f.auth.register("Astin", "one@example.test", "long-password");
    if (process.platform !== "win32") {
      await chmod(f.file, 0o644);
      await expect(DesktopAuth.open(f.file, f.options)).rejects.toThrow("UNSAFE_STORAGE");
      await chmod(f.file, 0o600);
      const link = f.file + ".link";
      await symlink(f.file, link);
      await expect(DesktopAuth.open(link, f.options)).rejects.toThrow("UNSAFE_STORAGE");
    }
    await writeFile(f.file, '{"version":2,"users":[]}');
    await expect(DesktopAuth.open(f.file, f.options)).rejects.toThrow("UNSAFE_STORAGE");
  });
  it("fixed main API rejects arbitrary inputs and honestly reports missing OAuth credentials", async () => {
    const f = await fixture(),
      c = new DesktopAuthController(f.auth, {}, async () => {
        throw Error("must not open");
      });
    expect(await c.call("oauth", { provider: "google" })).toMatchObject({ ok: false, error: "GOOGLE_NOT_CONFIGURED" });
    expect(await c.call("oauth", { provider: "github" })).toMatchObject({ ok: false, error: "GITHUB_NOT_CONFIGURED" });
    expect(
      await c.call("register", {
        login: "Astin",
        email: "one@example.test",
        password: "long-password",
        authenticated: true,
      }),
    ).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
    expect(await c.call("__proto__", {})).toMatchObject({ ok: false });
    expect(await c.call("status", {})).toMatchObject({ authenticated: false });
  });
});
