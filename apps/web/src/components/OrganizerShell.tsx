import type { ReactNode } from "react";
import { OrganizerNav } from "#src/components/OrganizerNav.tsx";
import { translatorFor } from "#src/lib/language.ts";
import type { OrganizerPage } from "#src/lib/organizer-page.ts";
import { AppShell } from "#src/ui/Shell.tsx";
import { Notice } from "#src/ui/Feedback.tsx";

/**
 * The frame of an organizer page: the dashboard shell with the organizer's navigation (and the event's pages inside an
 * event), or the error state when the API is down.
 */
export function OrganizerShell({
  page,
  path,
  children,
}: Readonly<{ page: OrganizerPage; path: string; children: ReactNode }>) {
  if (page.kind === "unavailable") {
    return (
      <AppShell language={page.language} path={path} signedIn>
        <Notice tone="danger" role="alert">
          {translatorFor(page.language)("error.generic")}
        </Notice>
      </AppShell>
    );
  }
  return (
    <AppShell
      language={page.language}
      path={path}
      signedIn
      nav={
        <OrganizerNav
          language={page.language}
          organizerId={page.membership.organizerId}
          organizerName={page.membership.organizerName}
          path={path}
        />
      }
    >
      {children}
    </AppShell>
  );
}
