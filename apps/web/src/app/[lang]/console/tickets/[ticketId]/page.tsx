import { notFound } from "next/navigation";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { ConsoleTicket } from "#src/components/ConsoleTicket.tsx";
import { consolePage } from "#src/lib/console-page.ts";
import { isTicketId } from "#src/lib/console-tickets.ts";

type Props = Readonly<{ params: Promise<{ lang: string; ticketId: string }> }>;

/** One ticket of Questify's queue (T-312). Platform admins only; any other ticket reads as not found. */
export default async function ConsoleTicketPage({ params }: Props) {
  const { lang, ticketId } = await params;
  const page = await consolePage(lang);
  if (!isTicketId(ticketId)) {
    notFound();
  }
  return (
    <ConsoleShell page={page} path={`/console/tickets/${ticketId}`}>
      <ConsoleTicket language={page.language} ticketId={ticketId} />
    </ConsoleShell>
  );
}
