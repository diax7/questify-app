import { OrganizerAlertSwitchesPanel } from "#src/components/OrganizerAlertSwitchesPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { TeamPanel } from "#src/components/TeamPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string }> }>;

/** An organizer's team. A person who is not a member sees "not found", as the API answers. */
export default async function TeamPage({ params }: Props) {
  const { lang, organizerId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/team`}>
      {page.kind === "member" ? (
        <>
          <TeamPanel
            language={page.language}
            organizerId={organizerId}
            myRole={page.membership.role}
          />
          <OrganizerAlertSwitchesPanel language={page.language} organizerId={organizerId} />
        </>
      ) : null}
    </OrganizerShell>
  );
}
