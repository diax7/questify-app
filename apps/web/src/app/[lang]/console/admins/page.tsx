import { ConsoleAdmins } from "#src/components/ConsoleAdmins.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's admin accounts and their sessions, with the forced sign-out (T-709, FR-1785). Platform admins only. */
export default async function ConsoleAdminsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleAdmins language={page.language} />;
}
