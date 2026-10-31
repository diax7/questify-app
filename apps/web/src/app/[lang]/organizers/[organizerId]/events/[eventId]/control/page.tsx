import { ControlRoom } from "#src/components/ControlRoom.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** The live control room (T-603): counters, the latest completions, the quests' rates and the actions that run the event. */
export default async function ControlPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <ControlRoom language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
