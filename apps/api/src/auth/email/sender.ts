export type EmailMessage = Readonly<{ to: string; subject: string; text: string }>;

export type EmailSender = Readonly<{
  /** Short name for logs, such as "smtp" or "resend". Never an address. */
  name: string;
  /** @throws EmailSendError when the message was not accepted by the provider. */
  send: (message: EmailMessage) => Promise<void>;
}>;

/** A provider refused or did not answer. The message never contains the recipient or the code. */
export class EmailSendError extends Error {
  readonly sender: string;

  constructor(sender: string, reason: string, options?: { cause?: unknown }) {
    super(`Email sender "${sender}" failed: ${reason}`, options);
    this.name = "EmailSendError";
    this.sender = sender;
  }
}

export const SEND_TIMEOUT_MS = 5000;
