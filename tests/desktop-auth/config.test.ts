import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), verify: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.create } }));
import { mailDelivery } from "../../src/desktop-auth/config.js";
import { verifyGmail } from "../../src/desktop-auth/providers.js";
afterEach(() => vi.resetAllMocks());
const credentials = {
  googleId: "123456789-fixture.apps.googleusercontent.com",
  googleSecret: "GOCSPX-fixture-not-live",
  githubId: "fixture123456789",
  githubSecret: "0123456789abcdef0123456789abcdef01234567",
  gmail: "fixture@gmail.com",
  appPassword: "abcdefghijklmnop",
};
describe("main-only SMTP", () => {
  it("refuses unconfigured SMTP without logging an OTP or reading .env", async () => {
    await expect(mailDelivery({})("person@example.test", "123456")).rejects.toThrow("SMTP_NOT_CONFIGURED");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("verifies Gmail with TLS and maps errors without provider diagnostics", async () => {
    mocks.create.mockReturnValue({ verify: mocks.verify, close: mocks.close });
    mocks.verify.mockResolvedValue(true);
    await verifyGmail(credentials);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        debug: false,
        logger: false,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      }),
    );
    mocks.verify.mockRejectedValue(Error(credentials.appPassword));
    await expect(verifyGmail(credentials)).rejects.toThrow("SMTP_VERIFY_FAILED");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it("sends the actual OTP and rejects failed SMTP acceptance", async () => {
    mocks.create.mockReturnValue({ sendMail: mocks.send, close: mocks.close });
    mocks.send.mockResolvedValue({ accepted: ["person@example.test"], rejected: [] });
    const send = mailDelivery({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_USER: credentials.gmail,
      SMTP_FROM: credentials.gmail,
      SMTP_PASS: credentials.appPassword,
    });
    expect(await send("person@example.test", "123456")).toBe("smtp");
    expect(mocks.send.mock.calls[0]![0].text).toContain("123456");
    mocks.send.mockResolvedValue({ accepted: [], rejected: ["person@example.test"] });
    await expect(send("person@example.test", "123456")).rejects.toThrow("EMAIL_DELIVERY_FAILED");
  });
});
