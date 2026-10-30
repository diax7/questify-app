import type { ReactNode } from "react";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ children: ReactNode; params: Promise<{ lang: string }> }>;

/**
 * The frame of every console page: the top bar and the console's navigation stay on screen while the page beside them
 * changes. Each page still checks the session and the platform-admin role itself, since a layout does not run again
 * when a page changes.
 */
export default async function ConsoleLayout({ children, params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleShell page={page}>{children}</ConsoleShell>;
}
