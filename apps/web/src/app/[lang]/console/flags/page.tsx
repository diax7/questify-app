import { ConsoleFlags } from "#src/components/ConsoleReports.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Open anti-cheat flags across events (T-705b, FR-1404). Platform admins only. */
export default async function ConsoleFlagsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleFlags language={page.language} />;
}
