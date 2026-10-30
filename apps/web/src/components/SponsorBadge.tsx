"use client";

import {
  teamSponsorListSchema,
  type Language,
  type SponsorTagKind,
  type TeamSponsor,
} from "@questify/shared";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { sponsorName, sponsorOf } from "#src/lib/sponsors.ts";
import { Badge } from "#src/ui/Feedback.tsx";

const Sponsors = createContext<readonly TeamSponsor[]>([]);

/**
 * Reads the event's sponsors once for the badges under it (FR-1302: a quest's or a reward's settings show its sponsor).
 * The badge is information only, so a failed read shows no badge and no message.
 */
export function SponsorBadgesScope({
  organizerId,
  eventId,
  children,
}: Readonly<{ organizerId: string; eventId: string; children: ReactNode }>) {
  const [sponsors, setSponsors] = useState<readonly TeamSponsor[]>([]);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/sponsors`).then(
      (result) => {
        const parsed = result.ok ? teamSponsorListSchema.safeParse(result.body) : null;
        if (current && parsed?.success === true) setSponsors(parsed.data.sponsors);
      },
    );
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return <Sponsors value={sponsors}>{children}</Sponsors>;
}

/** "Presented by {sponsor}" beside a quest, category or reward that has a sponsor; nothing for one that has none. */
export function SponsorBadge({
  language,
  kind,
  targetId,
}: Readonly<{ language: Language; kind: SponsorTagKind; targetId: string }>) {
  const t = useTranslator(language);
  const sponsor = sponsorOf(useContext(Sponsors), kind, targetId);
  return sponsor === undefined ? null : (
    <Badge tone="info">{t("sponsors.presentedBy", { name: sponsorName(sponsor, language) })}</Badge>
  );
}
