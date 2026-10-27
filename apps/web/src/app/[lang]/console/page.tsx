import { ConsoleContentLink } from "#src/components/ConsoleContent.tsx";
import { ConsoleInvitationsLink } from "#src/components/ConsoleInvitations.tsx";
import { ConsoleQuestifyLink } from "#src/components/ConsoleQuestify.tsx";
import { ConsoleQueue } from "#src/components/ConsoleQueue.tsx";
import { ConsoleSeasonsLink } from "#src/components/ConsoleSeasons.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { ConsoleTicketsLink } from "#src/components/ConsoleTickets.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's home: the links to Tickets with the open count (T-312) and to the Questify quests (T-403c), to the daily Content with its warning badge (T-406c), to the ranking seasons (T-408c), to the invitation requests (T-409b), the activation queue and the lookup by join code (T-210). Platform admins only. */
export default async function ConsoleHome({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console">
      <ConsoleTicketsLink language={page.language} />
      <ConsoleQuestifyLink language={page.language} />
      <ConsoleContentLink language={page.language} />
      <ConsoleSeasonsLink language={page.language} />
      <ConsoleInvitationsLink language={page.language} />
      <ConsoleQueue language={page.language} />
    </ConsoleShell>
  );
}
