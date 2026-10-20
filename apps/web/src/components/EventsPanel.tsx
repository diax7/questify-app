"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { nameFor, type EventView } from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * An organizer's events (FR-1001): newest first, each with its status at this moment and its times in its own zone
 * (FR-1728). A draft says Questify activates it after payment (FR-1017). An editor limited to chosen events sees only
 * those; the API decides.
 */
export function EventsPanel({
  language,
  organizerId,
}: Readonly<{ language: Language; organizerId: string }>) {
  const t = translatorFor(language);
  const base = `/${language}/organizers/${organizerId}/events`;
  const [events, setEvents] = useState<readonly EventView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events`).then((result) => {
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (result.ok) {
        setEvents((result.body as { events: EventView[] }).events);
      } else {
        setProblem(describeProblem(result.body, language, t).text);
      }
    });
  }, [organizerId, language, t]);

  return (
    <section className={styles.panel} aria-labelledby="events-title">
      <div className={styles.row}>
        <h1 id="events-title" className={styles.title}>
          {t("events.title")}
        </h1>
        <a className={styles.button} href={`${base}/new`}>
          {t("events.new")}
        </a>
      </div>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {events === null ? (
        problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : events.length === 0 ? (
        <p className={styles.muted}>{t("events.none")}</p>
      ) : (
        <ul className={styles.list}>
          {events.map((event) => (
            <li key={event.id} className={styles.card}>
              <a className={styles.textLink} href={`${base}/${event.id}`}>
                {nameFor(event, language)}
              </a>
              <span className={styles.badge}>{t(`events.status.${event.statusNow}`)}</span>
              <span className={styles.muted}>
                {formatEventTime(new Date(event.startsAt), event.timezone, language)}
              </span>
              {event.statusNow === "draft" ? (
                <span className={styles.muted}>{t("events.draftNote")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
