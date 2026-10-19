import { EmailSendError, type EmailMessage, type EmailSender } from "#src/auth/email/sender";

export const FAILOVER_DEADLINE_MS = 8000;

export type FailoverOptions = Readonly<{
  primary: EmailSender;
  /** Optional. Without it, a primary failure is the final failure. */
  backup?: EmailSender;
  /** Called when the backup takes over, with the names only. */
  onFailover?: (from: string, to: string) => void;
  deadlineMs?: number;
}>;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new EmailSendError("failover", `no sender finished within ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Sends with the primary sender and, if it fails, with the backup. The same message (so the same code)
 * goes to both, and the whole attempt is capped so a sign-in never waits long on email.
 *
 * @throws EmailSendError when no sender accepted the message.
 */
export function createFailoverSender(options: FailoverOptions): EmailSender {
  const attempt = async (message: EmailMessage): Promise<void> => {
    try {
      await options.primary.send(message);
      return;
    } catch (primaryError) {
      if (options.backup === undefined) {
        throw primaryError;
      }
      options.onFailover?.(options.primary.name, options.backup.name);
      try {
        await options.backup.send(message);
      } catch (backupError) {
        throw new EmailSendError("failover", "every sender failed", {
          cause: new AggregateError([primaryError, backupError]),
        });
      }
    }
  };
  return {
    name: "failover",
    send: (message) => withDeadline(attempt(message), options.deadlineMs ?? FAILOVER_DEADLINE_MS),
  };
}
