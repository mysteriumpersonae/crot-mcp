import { describe, expect, it, vi } from "vitest";
import { ProviderSettings, validateProviders, ProviderError } from "../../src/desktop-auth/providers.js";
const valid = () => ({
  googleId: "123456789-fixture.apps.googleusercontent.com",
  googleSecret: "GOCSPX-fixture-not-live",
  githubId: "fixture123456789",
  githubSecret: "0123456789abcdef0123456789abcdef01234567",
  gmail: "fixture@gmail.com",
  appPassword: "abcd efgh ijkl mnop",
});
describe("OS-vault provider bootstrap", () => {
  it("strictly validates format and normalizes only grouped app passwords", () => {
    expect(validateProviders(valid()).appPassword).toBe("abcdefghijklmnop");
    for (const v of [
      null,
      [],
      {},
      { ...valid(), extra: "x" },
      { ...valid(), gmail: "no@evil.test" },
      { ...valid(), googleId: "https://evil.test" },
      { ...valid(), appPassword: "bad" },
    ])
      expect(() => validateProviders(v)).toThrow("PROVIDER_FORMAT");
  });
  it("verifies before replacing and returns only safe booleans", async () => {
    let stored: string | null = null;
    const order: string[] = [];
    const entry = {
      getPassword: async () => stored,
      setPassword: async (v: string) => {
        order.push("store");
        stored = v;
      },
    };
    const p = new ProviderSettings(
      async () => entry,
      async () => {
        order.push("verify");
      },
    );
    expect(await p.call("providers-status", {})).toEqual({ ok: true, configured: false });
    expect(await p.call("providers-save", valid())).toEqual({
      ok: true,
      configured: true,
      smtpVerified: true,
      oauthFormatValid: true,
    });
    expect(order).toEqual(["verify", "store"]);
    const reopened = new ProviderSettings(async () => entry);
    expect((await reopened.load())?.SMTP_PASS).toBe("abcdefghijklmnop");
    expect(await reopened.call("providers-status", {})).toEqual({ ok: true, configured: true });
  });
  it("locks configured and corrupt records across restarts without SMTP or mutation", async () => {
    for (const record of [JSON.stringify(valid()), "corrupt-existing-record"]) {
      const write = vi.fn(),
        verify = vi.fn();
      const entry = async () => ({ getPassword: async () => record, setPassword: write });
      for (const p of [new ProviderSettings(entry, verify), new ProviderSettings(entry, verify)])
        expect(await p.call("providers-save", valid())).toEqual({ ok: false, error: "PROVIDERS_LOCKED" });
      expect(write).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    }
  });
  it("does not overwrite a record that appeared during SMTP verification", async () => {
    let stored: string | null = null;
    const write = vi.fn();
    const p = new ProviderSettings(
      async () => ({ getPassword: async () => stored, setPassword: write }),
      async () => {
        stored = "another-owner-setup";
      },
    );
    expect(await p.call("providers-save", valid())).toEqual({ ok: false, error: "PROVIDERS_LOCKED" });
    expect(write).not.toHaveBeenCalled();
  });
  it("fails closed on locked/missing store without native diagnostics", async () => {
    const p = new ProviderSettings(async () => {
      throw Error(valid().googleSecret);
    });
    expect(await p.call("providers-status", {})).toEqual({
      ok: false,
      configured: false,
      error: "SECRET_STORE_UNAVAILABLE",
    });
    expect(await p.call("providers-save", valid())).toEqual({ ok: false, error: "SECRET_STORE_UNAVAILABLE" });
  });
  it("preserves old config on SMTP failure and blocks parallel writes", async () => {
    const write = vi.fn();
    const factory = async () => ({ getPassword: async () => null, setPassword: write });
    const fail = new ProviderSettings(factory, async () => {
      throw new ProviderError("SMTP_VERIFY_FAILED");
    });
    expect(await fail.call("providers-save", valid())).toEqual({ ok: false, error: "SMTP_VERIFY_FAILED" });
    expect(write).not.toHaveBeenCalled();
    let release!: () => void;
    const slow = new ProviderSettings(
      factory,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const saving = slow.call("providers-save", valid());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await slow.call("providers-save", valid())).toEqual({ ok: false, error: "AUTH_BUSY" });
    release();
    await saving;
  });
});
