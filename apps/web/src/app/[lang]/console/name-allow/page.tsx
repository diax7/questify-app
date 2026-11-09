import { ConsoleNameAllow } from "#src/components/ConsoleNameAllow.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's full-name allow-list (FR-1779, ADR-817). Platform admins only. */
export default async function ConsoleNameAllowPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleNameAllow language={page.language} />;
}
