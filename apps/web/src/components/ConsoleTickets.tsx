"use client";

import { TICKET_KINDS, type Language, type TicketKind } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import { nameIn } from "#src/lib/console.ts";
import {
  consoleTicketQuery,
  deviceLine,
  readConsoleCounts,
  readConsoleTickets,
  type ConsoleCounts,
  type ConsoleSource,
  type ConsoleTab,
  type ConsoleTicketRow,
} from "#src/lib/console-tickets.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { kindKey } from "#src/lib/tickets.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Select } from "#src/ui/Field.tsx";
import { NavItem } from "#src/ui/Nav.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, Toolbar } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const timeOf = (iso: string, language: Language) =>
  new Date(iso).toLocaleString(language === "ar" ? "ar-SA-u-nu-latn" : "en-GB");

/** One page of the queue at a time, with the counts. */
function useQueue(tab: ConsoleTab, kind: TicketKind | null, source: ConsoleSource | null) {
  const [rows, setRows] = useState<ConsoleTicketRow[] | null>(null);
  const [counts, setCounts] = useState<ConsoleCounts | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const loadedFor = useRef<string | null>(null);
  const load = async (cursor: string | null) => {
    const result = await requestJson(
      "GET",
      `/v1/admin/tickets${consoleTicketQuery(tab, kind, source, cursor)}`,
    );
    const page = result.ok ? readConsoleTickets(result.body) : undefined;
    if (page === undefined) {
      setFailed(result.body ?? "network");
      return;
    }
    setFailed(null);
    setRows((current) => (cursor === null ? page.tickets : [...(current ?? []), ...page.tickets]));
    setCounts(page.counts);
    setNext(page.nextCursor);
  };
  useEffect(() => {
    const wanted = `${tab}:${kind ?? ""}:${source ?? ""}`;
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loadedFor.current === wanted) {
      return;
    }
    loadedFor.current = wanted;
    setRows(null);
    void load(null);
  });
  return { rows, counts, failed, more: next === null ? null : () => void load(next) };
}

function QueueRow({ language, row }: Readonly<{ language: Language; row: ConsoleTicketRow }>) {
  const t = translatorFor(language);
  return (
    <Card as="li" data-testid="console-ticket">
      <Toolbar>
        <Badge>{t(kindKey(row.kind))}</Badge>
        <Badge>
          {t(row.event === null ? "console.tickets.direct" : "console.tickets.escalated")}
        </Badge>
        <time dateTime={row.createdAt} dir="ltr">
          {t("console.tickets.sent", { date: timeOf(row.createdAt, language) })}
        </time>
        {row.username === null ? null : (
          <span dir="auto">{t("console.tickets.from", { username: row.username })}</span>
        )}
      </Toolbar>
      {row.event === null ? null : (
        <Muted dir="auto">
          {row.event.organizerName ?? ""} · {nameIn(row.event.name, language)}
        </Muted>
      )}
      {row.device === null ? null : <Muted dir="ltr">{deviceLine(row.device)}</Muted>}
      <p dir="auto">
        <TextLink href={`/${language}/console/tickets/${row.id}`}>{row.preview}</TextLink>
      </p>
    </Card>
  );
}

/**
 * The console's Tickets (T-312, FR-1823): Questify's queue, Open oldest first and Closed newest first, filtered by
 * kind and by source (Direct: app problems and suggestions; Escalated: from an event team). Each row is a preview
 * that opens the ticket. Every read is audited by the API.
 */
export function ConsoleTickets({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [tab, setTab] = useState<ConsoleTab>("open");
  const [kind, setKind] = useState<TicketKind | null>(null);
  const [source, setSource] = useState<ConsoleSource | null>(null);
  const queue = useQueue(tab, kind, source);
  return (
    <Stack as="section" aria-labelledby="console-tickets-title">
      <PageHeader titleId="console-tickets-title" title={t("console.tickets.title")} />
      <Tabs
        tablist
        label={t("console.tickets.title")}
        items={(["open", "closed"] as const).map((name) => ({
          key: name,
          label: t(name === "open" ? "tickets.open" : "tickets.closed", {
            count: queue.counts?.[name] ?? 0,
          }),
          current: tab === name,
          select: () => setTab(name),
        }))}
      />
      <FieldGroup layout="columns">
        <Field label={t("tickets.kindFilter")}>
          <Select
            value={kind ?? ""}
            onChange={(event) =>
              setKind(event.target.value === "" ? null : (event.target.value as TicketKind))
            }
          >
            <option value="">{t("tickets.allKinds")}</option>
            {TICKET_KINDS.map((name) => (
              <option key={name} value={name}>
                {t(kindKey(name))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("console.tickets.source")}>
          <Select
            value={source ?? ""}
            onChange={(event) =>
              setSource(event.target.value === "" ? null : (event.target.value as ConsoleSource))
            }
          >
            <option value="">{t("console.tickets.allSources")}</option>
            <option value="direct">{t("console.tickets.direct")}</option>
            <option value="escalated">{t("console.tickets.escalated")}</option>
          </Select>
        </Field>
      </FieldGroup>
      {queue.failed === null ? null : (
        <Notice tone="danger" role="alert">
          {queue.failed === "network" ? t("join.network") : problemOf(queue.failed, language, t)}
        </Notice>
      )}
      {queue.rows === null && queue.failed === null ? <Muted>{t("common.loading")}</Muted> : null}
      {queue.rows?.length === 0 ? <EmptyState>{t("tickets.empty")}</EmptyState> : null}
      <CardList>
        {(queue.rows ?? []).map((row) => (
          <QueueRow key={row.id} language={language} row={row} />
        ))}
      </CardList>
      {queue.more === null ? null : (
        <Button variant="quiet" onClick={queue.more}>
          {t("tickets.more")}
        </Button>
      )}
    </Stack>
  );
}

/** This page's item in the console's navigation, with the number of open tickets. */
export function ConsoleTicketsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    // The console API serves one call at a time per admin: on its own page the count comes with the page's read.
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
    <NavItem href={`/${language}/console/tickets`} current={current}>
      {open === null ? t("console.tickets.title") : t("console.tickets.link", { count: open })}
    </NavItem>
  );
}
