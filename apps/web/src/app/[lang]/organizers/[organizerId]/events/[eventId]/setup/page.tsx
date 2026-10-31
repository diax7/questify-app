import { SetupWizard } from "#src/components/SetupWizard.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";
import { stepOfPage, stepOfQuery } from "#src/lib/setup.ts";

type Props = Readonly<{
  params: Promise<{ lang: string; organizerId: string; eventId: string }>;
  searchParams: Promise<{ step?: string; only?: string; from?: string }>;
}>;

/**
 * An event's guided setup (T-605): ten skippable steps that resume where they stopped. `?step=` opens a step, `only=1`
 * shows it alone (an event page's "Explain this"), and `from=` names the page to return to, kept only when it is a page
 * that has a step.
 */
export default async function SetupPage({ params, searchParams }: Props) {
  const { lang, organizerId, eventId } = await params;
  const query = await searchParams;
  const page = await organizerPage(lang, organizerId);
  const from =
    query.from !== undefined && stepOfPage(query.from) !== undefined ? query.from : undefined;
  return page.kind === "member" ? (
    <SetupWizard
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      myRole={page.membership.role}
      startAt={stepOfQuery(query.step ?? null)}
      only={query.only === "1"}
      from={from}
    />
  ) : null;
}
