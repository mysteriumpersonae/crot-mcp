/** Main-only SMTP. Desktop credentials come from the OS vault, never .env or process.env. */
import nodemailer from "nodemailer";
import { AuthError, validEmail } from "./store.js";
export type AuthEnvironment = Record<string, string | undefined>;
export function smtpTransport(env: AuthEnvironment) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS || !validEmail(env.SMTP_FROM))
    throw new AuthError("SMTP_NOT_CONFIGURED");
  const port = Number(env.SMTP_PORT || "465");
  if (![465, 587].includes(port)) throw new AuthError("SMTP_CONFIG_INVALID");
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: false,
    debug: false,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
}
export function mailDelivery(env: AuthEnvironment) {
  return async (email: string, code: string): Promise<"smtp"> => {
    const transport = smtpTransport(env);
    try {
      const r = await transport.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: "CROT — Email verification / Подтверждение почты",
        text: `CROT\nКод подтверждения / Verification code: ${code}\nДействует 10 минут / Valid for 10 minutes.`,
      });
      if (!r.accepted?.length || r.rejected?.length) throw new AuthError("EMAIL_DELIVERY_FAILED");
      return "smtp";
    } finally {
      transport.close();
    }
  };
}
