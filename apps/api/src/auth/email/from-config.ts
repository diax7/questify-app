import { createFailoverSender } from "#src/auth/email/failover";
import { createGmailSender } from "#src/auth/email/gmail";
import { createResendSender } from "#src/auth/email/resend";
import type { EmailSender } from "#src/auth/email/sender";
import type { AuthConfig } from "#src/config";

export type EmailSenderOptions = Readonly<{
  /** Called on each provider, by name: the server counts its sends here. */
  wrap?: (sender: EmailSender, provider: string) => EmailSender;
  onFailover?: (from: string, to: string) => void;
}>;

/** Gmail, then Resend when it is configured. The server and `staff.cjs create` send through this. */
export function createEmailSender(
  auth: Pick<AuthConfig, "gmail" | "resend">,
  options: EmailSenderOptions = {},
): EmailSender {
  const { gmail, resend } = auth;
  const wrap = options.wrap ?? ((sender) => sender);
  const primary = wrap(
    createGmailSender({
      key: gmail.key,
      from: gmail.from,
      ...(gmail.actAs === undefined ? {} : { actAs: gmail.actAs }),
    }),
    "gmail",
  );
  const backup = resend === undefined ? undefined : wrap(createResendSender(resend), "resend");
  return createFailoverSender({
    primary,
    ...(backup === undefined ? {} : { backup }),
    ...(options.onFailover === undefined ? {} : { onFailover: options.onFailover }),
  });
}
