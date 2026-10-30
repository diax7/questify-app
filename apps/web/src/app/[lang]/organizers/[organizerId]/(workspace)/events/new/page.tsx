import { EventForm } from "#src/components/EventForm.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string }> }>;

/** A new event, saved as a draft until Questify activates it. */
export default async function NewEventPage({ params }: Props) {
  const { lang, organizerId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/new`}>
      {page.kind === "member" ? (
        <EventForm
          language={page.language}
          organizerId={organizerId}
          myRole={page.membership.role}
        />
      ) : null}
    </OrganizerShell>
  );
}
