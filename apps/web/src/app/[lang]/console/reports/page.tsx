import { ConsoleReports } from "#src/components/ConsoleReports.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Questify's moderation queue (T-705b, FR-1404). Platform admins only. */
export default async function ConsoleReportsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleReports language={page.language} />;
}
