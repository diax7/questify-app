import type { ReactNode } from "react";
import { ConsoleNav } from "#src/components/ConsoleNav.tsx";
import type { ConsolePage } from "#src/lib/console-page.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

/** The frame of a console page: "Questify console" in the top bar, so it is never mistaken for the dashboard. */
export function ConsoleShell({
  page,
  path,
  children,
}: Readonly<{ page: ConsolePage; path: string; children: ReactNode }>) {
  const t = translatorFor(page.language);
  if (page.kind === "unavailable") {
    return (
      <AppShell language={page.language} path={path} signedIn title={t("console.title")}>
        <Notice tone="danger" role="alert">
          {t("error.generic")}
        </Notice>
      </AppShell>
    );
  }
  return (
    <AppShell
      language={page.language}
      path={path}
      signedIn
      title={t("console.title")}
      nav={<ConsoleNav language={page.language} path={path} />}
    >
      {children}
    </AppShell>
  );
}
