import type { ReactNode } from "react";
import { ConsoleNav } from "#src/components/ConsoleNav.tsx";
import type { ConsolePage } from "#src/lib/console-page.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

/**
 * The frame of the console pages: "Console" beside the logo in the top bar, so it is never mistaken for the dashboard.
 * It sits in a layout, so it stays while the pages beside it change.
 */
export function ConsoleShell({
  page,
  children,
}: Readonly<{ page: ConsolePage; children: ReactNode }>) {
  if (page.kind === "unavailable") {
    return (
      <AppShell language={page.language} signedIn area="console">
        <Notice tone="danger" role="alert">
          {translatorFor(page.language)("error.generic")}
        </Notice>
      </AppShell>
    );
  }
  return (
    <AppShell
      language={page.language}
      signedIn
      area="console"
      nav={<ConsoleNav language={page.language} />}
    >
      {children}
    </AppShell>
  );
}
