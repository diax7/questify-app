import { ConsoleInvitations } from "#src/components/ConsoleInvitations.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Questify's invitation requests (T-409b): the queue. Platform admins only; the API checks again on every call. */
export default async function ConsoleInvitationsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console/invitations">
      <ConsoleInvitations language={page.language} />
    </ConsoleShell>
  );
}
