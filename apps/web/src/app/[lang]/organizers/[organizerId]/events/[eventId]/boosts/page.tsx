import { BoostsPanel } from "#src/components/BoostsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's double-point boosts (T-307): the list, the form, Stop and Delete. */
export default async function BoostsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <BoostsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
