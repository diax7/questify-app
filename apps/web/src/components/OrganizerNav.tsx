"use client";

import { termFor, type Language } from "@questify/shared";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import { EVENT_PAGES, eventPlaceIn, type EventPageLink } from "#src/lib/dashboard-nav.ts";
import { invitationsOpen, invitationsPath } from "#src/lib/invitations.ts";
import { pathAfterLanguage, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import type { TicketPage } from "#src/lib/tickets.ts";
import { NavGroup, NavItem } from "#src/ui/Nav.tsx";

/**
 * The event's open help requests, once read; null until then or when they cannot be read. The shell stays while the
 * pages change, so `page` (the address) makes it read again on each page: one call per page change, the earlier count
 * showing until the new one arrives.
 */
function useOpenTickets(organizerId: string, eventId: string | null, page: string): number | null {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (eventId === null) {
      return;
    }
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/tickets?limit=1`).then(
      (result) => {
        const counts = result.ok ? (result.body as Partial<TicketPage>).counts : undefined;
        if (current && typeof counts?.open === "number") {
          setOpen(counts.open);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [organizerId, eventId, page]);
  return open;
}

/** Whether Questify's invitations are open to this event (the Invitations page is listed only then), read on each `page`. */
function useInvitationsOpen(organizerId: string, eventId: string | null, page: string): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (eventId === null) {
      return;
    }
    let current = true;
    void requestJson("GET", invitationsPath(organizerId, eventId)).then((result) => {
      if (current && result.ok) {
        setEnabled(invitationsOpen(result));
      }
    });
    return () => {
      current = false;
    };
  }, [organizerId, eventId, page]);
  return enabled;
}

const GROUPS = [
  { group: "setup", label: "dashNav.setup" },
  { group: "during", label: "dashNav.during" },
  { group: "review", label: "dashNav.review" },
] as const;

/**
 * The dashboard's navigation inside one organizer (ADR-364): its events and team with the open event's overview, and
 * inside an event every other page of that event, grouped by when the organizer needs it. The open page is marked,
 * read from the address, so the navigation stays mounted while the page beside it changes.
 */
export function OrganizerNav({
  language,
  organizerId,
  organizerName,
}: Readonly<{ language: Language; organizerId: string; organizerName: string }>) {
  const t = useTranslator(language);
  const terms = useEventTerms();
  const path = pathAfterLanguage(usePathname());
  const place = eventPlaceIn(path);
  const eventId = place?.eventId ?? null;
  const openTickets = useOpenTickets(organizerId, eventId, path);
  const invitations = useInvitationsOpen(organizerId, eventId, path);
  const base = `/${language}/organizers/${organizerId}`;

  const labelOf = (link: EventPageLink, words: Translate): string => {
    if (link.label === "players") {
      return termFor(terms.player, language);
    }
    if (link.label === "help") {
      return openTickets === null || openTickets === 0
        ? words("tickets.link")
        : words("tickets.linkCount", { count: openTickets });
    }
    return words(link.label === "invitations" ? "invCampaign.link" : link.label);
  };

  const eventItem = (link: EventPageLink, within: string, current: string) => (
    <NavItem
      key={link.slug}
      href={`${base}/events/${within}${link.slug === "" ? "" : `/${link.slug}`}`}
      icon={link.icon}
      current={current === link.slug}
    >
      {labelOf(link, t)}
    </NavItem>
  );
  const pagesOf = (group: EventPageLink["group"]) =>
    EVENT_PAGES.filter((link) => link.group === group).filter(
      (link) => link.slug !== "invitations" || invitations,
    );

  return (
    <>
      <NavGroup label={organizerName}>
        <NavItem
          href={`${base}/events`}
          icon="calendar"
          current={path === `/organizers/${organizerId}/events`}
        >
          {t("events.title")}
        </NavItem>
        <NavItem
          href={`${base}/team`}
          icon="users"
          current={path === `/organizers/${organizerId}/team`}
        >
          {t("staff.team")}
        </NavItem>
        {place === null
          ? null
          : pagesOf("event").map((link) => eventItem(link, place.eventId, place.slug))}
      </NavGroup>
      {place === null
        ? null
        : GROUPS.map(({ group, label }) => (
            <NavGroup key={group} label={t(label)}>
              {pagesOf(group).map((link) => eventItem(link, place.eventId, place.slug))}
            </NavGroup>
          ))}
    </>
  );
}
