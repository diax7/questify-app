"use client";

import { termFor, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import { EVENT_PAGES, eventPlaceIn, type EventPageLink } from "#src/lib/dashboard-nav.ts";
import { invitationsOpen, invitationsPath } from "#src/lib/invitations.ts";
import type { Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import type { TicketPage } from "#src/lib/tickets.ts";
import { NavGroup, NavItem } from "#src/ui/Nav.tsx";

/** The event's open help requests, once read; null until then or when they cannot be read. */
function useOpenTickets(organizerId: string, eventId: string | null): number | null {
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
  }, [organizerId, eventId]);
  return open;
}

/** Whether Questify's invitations are open to this event (the Invitations page is listed only then). */
function useInvitationsOpen(organizerId: string, eventId: string | null): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (eventId === null) {
      return;
    }
    let current = true;
    void requestJson("GET", invitationsPath(organizerId, eventId)).then((result) => {
      if (current) {
        setEnabled(invitationsOpen(result));
      }
    });
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return enabled;
}

const GROUPS = [
  { group: "event", label: "dashNav.thisEvent" },
  { group: "setup", label: "dashNav.setup" },
  { group: "during", label: "dashNav.during" },
  { group: "review", label: "dashNav.review" },
] as const;

/**
 * The dashboard's navigation inside one organizer (ADR-364): its events and team, and inside an event every page of
 * that event, grouped by when the organizer needs it. The open page is marked.
 */
export function OrganizerNav({
  language,
  organizerId,
  organizerName,
  path,
}: Readonly<{ language: Language; organizerId: string; organizerName: string; path: string }>) {
  const t = useTranslator(language);
  const terms = useEventTerms();
  const place = eventPlaceIn(path);
  const eventId = place?.eventId ?? null;
  const openTickets = useOpenTickets(organizerId, eventId);
  const invitations = useInvitationsOpen(organizerId, eventId);
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

  return (
    <>
      <NavGroup label={organizerName}>
        <NavItem href={`${base}/events`} current={path === `/organizers/${organizerId}/events`}>
          {t("events.title")}
        </NavItem>
        <NavItem href={`${base}/team`} current={path === `/organizers/${organizerId}/team`}>
          {t("staff.team")}
        </NavItem>
      </NavGroup>
      {place === null
        ? null
        : GROUPS.map(({ group, label }) => (
            <NavGroup key={group} label={t(label)}>
              {EVENT_PAGES.filter((link) => link.group === group)
                .filter((link) => link.slug !== "invitations" || invitations)
                .map((link) => (
                  <NavItem
                    key={link.slug}
                    href={`${base}/events/${place.eventId}${link.slug === "" ? "" : `/${link.slug}`}`}
                    current={place.slug === link.slug}
                  >
                    {labelOf(link, t)}
                  </NavItem>
                ))}
            </NavGroup>
          ))}
    </>
  );
}
