"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { API, hasWarning, questifyDayOf, readDailyConsole } from "#src/lib/console-daily.ts";
import { INVITATIONS_API, readQueue, waitingCount } from "#src/lib/console-invitations.ts";
import { readReportCounts, REPORT_COUNTS_API } from "#src/lib/console-reports.ts";
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

/** This page's item in the console's navigation (T-709b). */
export function ConsoleCatalogLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/catalog`} icon="award" current={current}>
      {t("console.catalog.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-713). */
export function ConsoleHomeLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/home`} icon="layout" current={current}>
      {t("console.home.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation. */
export function ConsoleTranslationsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/translations`} icon="globe" current={current}>
      {t("console.translations.title")}
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

/** This page's item in the console's navigation. */
export function ConsoleUsageLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/usage`} icon="chart" current={current}>
      {t("console.usage.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-710). */
export function ConsoleReviewDemoLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/review-demo`} icon="check" current={current}>
      {t("console.reviewDemo.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-714). */
export function ConsoleFeatureUsageLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/feature-usage`} icon="star" current={current}>
      {t("console.featureUsage.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation. */
export function ConsoleReadinessLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/readiness`} icon="check" current={current}>
      {t("console.readiness.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-701). */
export function ConsoleOrganizersLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/organizers`} icon="users" current={current}>
      {t("console.organizers.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-704). */
export function ConsolePlayersLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/players`} icon="eye" current={current}>
      {t("console.players.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-705). */
export function ConsoleWordListsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/word-lists`} icon="shield" current={current}>
      {t("console.wordLists.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-705b), with the open urgent count (T-701b). */
export function ConsoleReportsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [urgent, setUrgent] = useState<number | null>(null);
  useEffect(() => {
    if (current) {
      return;
    }
    let alive = true;
    void requestJson("GET", REPORT_COUNTS_API).then((result) => {
      const counts = result.ok ? readReportCounts(result.body) : undefined;
      if (alive && counts !== undefined) {
        setUrgent(counts.urgent);
      }
    });
    return () => {
      alive = false;
    };
  }, [current]);
  return (
    <NavItem href={`/${language}/console/reports`} icon="alert" current={current}>
      {urgent === null || urgent === 0
        ? t("console.reports.title")
        : t("console.reports.link", { count: urgent })}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-705b). */
export function ConsoleFlagsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/flags`} icon="eyeOff" current={current}>
      {t("console.flags.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-709). */
export function ConsoleHealthLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/health`} icon="bolt" current={current}>
      {t("console.health.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-709). */
export function ConsoleNumbersLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/numbers`} icon="overview" current={current}>
      {t("console.numbers.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-707). */
export function ConsoleLegalLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/legal`} icon="file" current={current}>
      {t("console.legal.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-706). */
export function ConsoleMessagesLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/messages`} icon="mail" current={current}>
      {t("console.messages.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-709). */
export function ConsoleAdminsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/admins`} icon="shield" current={current}>
      {t("console.admins.title")}
    </NavItem>
  );
}

/** This page's item in the console's navigation (T-703). */
export function ConsoleSwitchesLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/switches`} icon="sliders" current={current}>
      {t("console.switches.title")}
    </NavItem>
  );
}
