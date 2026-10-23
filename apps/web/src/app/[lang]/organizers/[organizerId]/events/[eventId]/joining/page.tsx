import { AudiencePanel } from "#src/components/AudiencePanel.tsx";
import { GuestsPanel } from "#src/components/GuestsPanel.tsx";
import { JoinSetupPanel } from "#src/components/JoinSetupPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/**
 * An event's join setup (T-212): join fields, who can join, the welcome reward, the guest list, and who sees which
 * category and reward (T-220).
 */
export default async function JoiningPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/joining`}>
      {page.kind === "member" ? (
        <>
          <JoinSetupPanel language={page.language} organizerId={organizerId} eventId={eventId} />
          <GuestsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
          <AudiencePanel language={page.language} organizerId={organizerId} eventId={eventId} />
        </>
      ) : null}
    </OrganizerShell>
  );
}
