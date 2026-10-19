import { EmailSendError, SEND_TIMEOUT_MS, type EmailSender } from "#src/auth/email/sender";

export type ResendOptions = Readonly<{
  apiKey: string;
  /** An address on a domain verified with Resend (SPF and DKIM). */
  from: string;
  /** Replaces the real network call in tests. */
  fetch?: typeof fetch;
}>;

const ENDPOINT = "https://api.resend.com/emails";

/** Sends through the Resend HTTP API, capped at five seconds. */
export function createResendSender(options: ResendOptions): EmailSender {
  const call = options.fetch ?? fetch;
  return {
    name: "resend",
    send: async (message) => {
      let response: Response;
      try {
        response = await call(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new EmailSendError("resend", "the request failed or timed out", { cause: error });
      }
      if (!response.ok) {
        throw new EmailSendError("resend", `the API answered ${response.status}`);
      }
    },
  };
}
