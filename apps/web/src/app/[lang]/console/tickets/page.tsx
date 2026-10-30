import { ConsoleTickets } from "#src/components/ConsoleTickets.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Questify's ticket queue (T-312). Platform admins only; the API checks again on every call. */
export default async function ConsoleTicketsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleTickets language={page.language} />;
}
