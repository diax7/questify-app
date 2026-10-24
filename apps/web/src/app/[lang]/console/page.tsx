import { ConsoleQueue } from "#src/components/ConsoleQueue.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { ConsoleTicketsLink } from "#src/components/ConsoleTickets.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's home: the link to Tickets with the open count (T-312), the activation queue and the lookup by join code (T-210). Platform admins only. */
export default async function ConsoleHome({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console">
      <ConsoleTicketsLink language={page.language} />
      <ConsoleQueue language={page.language} />
    </ConsoleShell>
  );
}
