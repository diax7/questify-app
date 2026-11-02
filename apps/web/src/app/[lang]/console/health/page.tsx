import { ConsoleHealth } from "#src/components/ConsoleHealth.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's health view: six tiles of queues, leases and transports (T-709, FR-1783). Platform admins only. */
export default async function ConsoleHealthPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleHealth language={page.language} />;
}
