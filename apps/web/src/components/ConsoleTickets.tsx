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
import styles from "#src/components/layout.module.css";

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
    <li className={styles.card} data-testid="console-ticket">
      <p className={styles.row}>
        <span className={styles.badge}>{t(kindKey(row.kind))}</span>
        <span className={styles.badge}>
          {t(row.event === null ? "console.tickets.direct" : "console.tickets.escalated")}
        </span>
        <time dateTime={row.createdAt} dir="ltr">
          {t("console.tickets.sent", { date: timeOf(row.createdAt, language) })}
        </time>
        {row.username === null ? null : (
          <span dir="auto">{t("console.tickets.from", { username: row.username })}</span>
        )}
      </p>
      {row.event === null ? null : (
        <p className={styles.muted} dir="auto">
          {row.event.organizerName ?? ""} · {nameIn(row.event.name, language)}
        </p>
      )}
      {row.device === null ? null : (
        <p className={styles.muted} dir="ltr">
          {deviceLine(row.device)}
        </p>
      )}
      <p dir="auto">
        <a className={styles.textLink} href={`/${language}/console/tickets/${row.id}`}>
          {row.preview}
        </a>
      </p>
    </li>
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
    <section className={styles.panel} aria-labelledby="console-tickets-title">
      <h1 id="console-tickets-title" className={styles.title}>
        {t("console.tickets.title")}
      </h1>
      <div role="tablist" className={styles.row}>
        {(["open", "closed"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? styles.button : styles.quiet}
            onClick={() => setTab(name)}
          >
            {t(name === "open" ? "tickets.open" : "tickets.closed", {
              count: queue.counts?.[name] ?? 0,
            })}
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>{t("tickets.kindFilter")}</span>
          <select
            className={styles.input}
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
          </select>
        </label>
        <label className={styles.field}>
          <span>{t("console.tickets.source")}</span>
          <select
            className={styles.input}
            value={source ?? ""}
            onChange={(event) =>
              setSource(event.target.value === "" ? null : (event.target.value as ConsoleSource))
            }
          >
            <option value="">{t("console.tickets.allSources")}</option>
            <option value="direct">{t("console.tickets.direct")}</option>
            <option value="escalated">{t("console.tickets.escalated")}</option>
          </select>
        </label>
      </div>
      {queue.failed === null ? null : (
        <p role="alert" className={styles.alert}>
          {queue.failed === "network" ? t("join.network") : problemOf(queue.failed, language, t)}
        </p>
      )}
      {queue.rows === null && queue.failed === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : null}
      {queue.rows?.length === 0 ? <p className={styles.muted}>{t("tickets.empty")}</p> : null}
      <ul className={styles.list}>
        {(queue.rows ?? []).map((row) => (
          <QueueRow key={row.id} language={language} row={row} />
        ))}
      </ul>
      {queue.more === null ? null : (
        <button type="button" className={styles.quiet} onClick={queue.more}>
          {t("tickets.more")}
        </button>
      )}
    </section>
  );
}

/** The console home's link to Tickets, with the open count once it is read. */
export function ConsoleTicketsLink({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void requestJson("GET", "/v1/admin/tickets/counts").then((result) => {
      const counts = result.ok ? readConsoleCounts(result.body) : undefined;
      if (current && counts !== undefined) {
        setOpen(counts.open);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return (
    <p>
      <a className={styles.textLink} href={`/${language}/console/tickets`}>
        {open === null ? t("console.tickets.title") : t("console.tickets.link", { count: open })}
      </a>
    </p>
  );
}
