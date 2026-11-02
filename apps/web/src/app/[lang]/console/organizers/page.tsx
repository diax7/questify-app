import { ConsoleOrganizers } from "#src/components/ConsoleOrganizers.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's organizers: search, status, and one organizer's page (T-701, FR-1402). Platform admins only. */
export default async function ConsoleOrganizersPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleOrganizers language={page.language} />;
}
