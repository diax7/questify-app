"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { API, hasWarning, questifyDayOf, readDailyConsole } from "#src/lib/console-daily.ts";
import { INVITATIONS_API, readQueue, waitingCount } from "#src/lib/console-invitations.ts";
import { readConsoleCounts } from "#src/lib/console-tickets.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Badge } from "#src/ui/Feedback.tsx";
import { NavItem } from "#src/ui/Nav.tsx";

/*
 * The console's navigation items, apart from the pages they open so the navigation does not carry the pages' code.
 * The console API serves one call at a time per admin: a link that shows a count skips it while its own page is open,
 * because that page's read brings the count.
 */

/** This page's item in the console's navigation, with the number of open tickets. */
export function ConsoleTicketsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (current) {
      return;
    }
    let alive = true;
    void requestJson("GET", "/v1/admin/tickets/counts").then((result) => {
      const counts = result.ok ? readConsoleCounts(result.body) : undefined;
      if (alive && counts !== undefined) {
        setOpen(counts.open);
      }
    });
    return () => {
      alive = false;
    };
  }, [current]);
  return (
    <NavItem href={`/${language}/console/tickets`} icon="ticket" current={current}>
      {open === null ? t("console.tickets.title") : t("console.tickets.link", { count: open })}
    </NavItem>
  );
}

/** This page's item in the console's navigation. */
export function ConsoleQuestifyLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/questify`} icon="compass" current={current}>
      {t("console.questify.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation, with a badge while today's content needs attention. */
export function ConsoleContentLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [warn, setWarn] = useState(false);
  useEffect(() => {
    if (current) {
      return;
    }
    let alive = true;
    const today = questifyDayOf(new Date());
    void requestJson("GET", `${API}?from=${today}&to=${today}`).then((result) => {
      const read = result.ok ? readDailyConsole(result.body) : undefined;
      if (alive && read !== undefined) {
        setWarn(hasWarning(read.status));
      }
    });
    return () => {
      alive = false;
    };
  }, [current]);
  return (
    <NavItem href={`/${language}/console/content`} icon="file" current={current}>
      {t("console.content.title")}
      {warn ? (
        <span data-testid="content-badge">
          <Badge tone="warning">{t("console.content.needsAttention")}</Badge>
        </span>
      ) : null}
    </NavItem>
  );
}

/** This page's item in the console's navigation. */
export function ConsoleSeasonsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/seasons`} icon="sun" current={current}>
      {t("console.seasons.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation, with the number of requests waiting. */
export function ConsoleInvitationsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (current) {
      return;
    }
    let alive = true;
    void requestJson("GET", INVITATIONS_API).then((result) => {
      const campaigns = result.ok ? readQueue(result.body) : undefined;
      if (alive && campaigns !== undefined) {
        setWaiting(waitingCount(campaigns));
      }
    });
    return () => {
      alive = false;
    };
  }, [current]);
  return (
    <NavItem href={`/${language}/console/invitations`} icon="mail" current={current}>
      {waiting === 0
        ? t("console.invCampaign.title")
        : t("console.invCampaign.linkCount", { count: waiting })}
    </NavItem>
  );
}
