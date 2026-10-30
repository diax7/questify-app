import type { ReactNode } from "react";
import { OrganizerNav } from "#src/components/OrganizerNav.tsx";
import { translatorFor } from "#src/lib/language.ts";
import type { OrganizerPage } from "#src/lib/organizer-page.ts";
import { AppShell } from "#src/ui/Shell.tsx";
import { Notice } from "#src/ui/Feedback.tsx";

/**
 * The frame of the organizer pages: the dashboard shell with the organizer's navigation (and the event's pages inside
 * an event), or the error state when the API is down. It sits in a layout, so it stays while the pages beside it change.
 */
export function OrganizerShell({
  page,
  children,
}: Readonly<{ page: OrganizerPage; children: ReactNode }>) {
  if (page.kind === "unavailable") {
    return (
      <AppShell language={page.language} signedIn>
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
      nav={
        <OrganizerNav
          language={page.language}
          organizerId={page.membership.organizerId}
          organizerName={page.membership.organizerName}
        />
      }
    >
      {children}
    </AppShell>
  );
}
