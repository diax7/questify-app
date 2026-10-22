import { ConsoleEvent } from "#src/components/ConsoleEvent.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; eventId: string }> }>;

/** One event in the console: activate, reject, limit and add-ons (T-210). Platform admins only. */
export default async function ConsoleEventPage({ params }: Props) {
  const { lang, eventId } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path={`/console/events/${eventId}`}>
      <ConsoleEvent language={page.language} eventId={eventId} />
    </ConsoleShell>
  );
}
