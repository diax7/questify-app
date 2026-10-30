import { CodesPanel } from "#src/components/CodesPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's printed quest codes. An event out of reach shows the API's answer. */
export default async function CodesPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <CodesPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
