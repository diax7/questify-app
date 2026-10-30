import { QuestBuilder } from "#src/components/QuestBuilder.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's categories and quests. An event out of reach shows the API's answer. */
export default async function QuestsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <QuestBuilder language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
