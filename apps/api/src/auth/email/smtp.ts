import { createTransport } from "nodemailer";
import { EmailSendError, SEND_TIMEOUT_MS, type EmailSender } from "#src/auth/email/sender";

export type SmtpTransport = Readonly<{
  sendMail: (message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown>;
}>;

export type SmtpOptions = Readonly<{
  /** The Gmail address that signs in. Gmail sends from this address whatever else is asked. */
  user: string;
  /** A Google app password for a dedicated account (never a personal mailbox). */
  appPassword: string;
  /** Replaces the real connection in tests. */
  transport?: SmtpTransport;
}>;

/** Sends through Gmail's SMTP server over TLS, with every wait capped at five seconds. */
export function createSmtpSender(options: SmtpOptions): EmailSender {
  const transport: SmtpTransport =
    options.transport ??
    createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: options.user, pass: options.appPassword },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  return {
    name: "smtp",
    send: async (message) => {
      try {
        await transport.sendMail({
          from: `Questify <${options.user}>`,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
      } catch (error) {
        throw new EmailSendError("smtp", "the SMTP server did not accept the message", {
          cause: error,
        });
      }
    },
  };
}
