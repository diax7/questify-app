import type { ReactNode } from "react";
import { OrganizerNav } from "#src/components/OrganizerNav.tsx";
import { translatorFor } from "#src/lib/language.ts";
import type { Language } from "@questify/shared";
import { clockOf } from "#src/lib/console-organizers.ts";
import type { OrganizerPage } from "#src/lib/organizer-page.ts";
import type { Membership, Suspension } from "#src/lib/staff-api.ts";
import { AppShell } from "#src/ui/Shell.tsx";
import { Notice } from "#src/ui/Feedback.tsx";

/**
 * The frame of the organizer pages: the dashboard shell with the organizer's navigation (and the event's pages inside
 * an event), or the error state when the API is down. It sits in a layout, so it stays while the pages beside it change.
 */
export function OrganizerShell({
  page,
  event,
  children,
}: Readonly<{
  page: OrganizerPage;
  /** Inside an event: its id and Questify's suspension of it, for the banners (T-701). */
  event?: Readonly<{ id: string; suspension: Suspension | null }>;
  children: ReactNode;
}>) {
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
      <OrganizerBanners language={page.language} membership={page.membership} event={event} />
      {children}
    </AppShell>
  );
}

/**
 * What Questify has done here (T-701): a suspension of the organizer or of this event, with the reason Questify wrote
 * (Q-372), and, for a Questify admin on a support grant, until when they are in. The organizer never sees support.
 */
function OrganizerBanners({
  language,
  membership,
  event,
}: Readonly<{
  language: Language;
  membership: Membership;
  event: Readonly<{ id: string; suspension: Suspension | null }> | undefined;
}>) {
  const t = translatorFor(language);
  const grant = membership.support?.find((item) => item.eventId === event?.id);
  return (
    <>
      {membership.suspension === null ? null : (
        <Notice tone="warning" role="note">
          <bdi>{t("suspension.organizerBanner", { reason: membership.suspension.reason })}</bdi>
        </Notice>
      )}
      {event?.suspension === null || event?.suspension === undefined ? null : (
        <Notice tone="warning" role="note">
          <bdi>{t("suspension.eventBanner", { reason: event.suspension.reason })}</bdi>
        </Notice>
      )}
      {grant === undefined ? null : (
        <Notice tone="info" role="note">
          {t("support.banner", { time: clockOf(grant.expiresAt, language) })}
        </Notice>
      )}
    </>
  );
}
