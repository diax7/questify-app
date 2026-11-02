import { ConsoleReadiness } from "#src/components/ConsoleReadiness.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's readiness list: the go-live checklist of every event starting soon (T-618, FR-1845). Platform admins only. */
export default async function ConsoleReadinessPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleReadiness language={page.language} />;
}
