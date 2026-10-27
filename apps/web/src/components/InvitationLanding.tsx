"use client";
import { formatEventTime, type InvitationOpen, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import {
  joinPath,
  landingOf,
  textIn,
  tokenFromHash,
  type Landing,
} from "#src/lib/invitation-landing.ts";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import styles from "#src/components/layout.module.css";

const NOTES = {
  missing: "invCampaignPage.missing",
  ended: "invCampaignPage.ended",
  throttled: "invCampaignPage.throttled",
  unavailable: "invCampaignPage.unavailable",
} as const;

/** The event the invitation is for: its name, place, times, and the way into Questify. */
function EventCard({
  language,
  event,
}: Readonly<{ language: Language; event: InvitationOpen["event"] }>) {
  const t = translatorFor(language);
  const name = textIn(event.name, language);
  const venue = textIn(event.venue, language);
  return (
    <>
      <p className={styles.notice}>{t("invCampaignPage.lead")}</p>
      <h1 id="invitation-title" className={styles.title} dir="auto" data-testid="invitation-event">
        {name}
      </h1>
      {venue === "" ? null : (
        <p className={styles.muted} dir="auto">
          {venue}
        </p>
      )}
      {event.startsAt === null ? null : (
        <p>
          {t("eventPage.starts")}:{" "}
          {formatEventTime(new Date(event.startsAt), event.timezone, language)}
        </p>
      )}
      {event.endsAt === null ? null : (
        <p>
          {t("eventPage.ends")}: {formatEventTime(new Date(event.endsAt), event.timezone, language)}
        </p>
      )}
      <a className={styles.button} href={joinPath(language, event.joinCode)}>
        {t("invCampaignPage.open")}
      </a>
      <p className={styles.muted}>{t("invCampaignPage.openHint")}</p>
    </>
  );
}

/**
 * Where an invitation SMS lands (T-409b, ADR-332 (2)). The token is in the link's fragment, so no server log or
 * `Referer` has it: it is read once, removed from the address, and sent once to count the open; the answer is the
 * public event card only. A reload finds no token and says the link is incomplete (it is held in memory, never kept).
 */
export function InvitationLanding({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<Landing>({ kind: "reading" });
  const taken = useRef(false);

  // Once per page, also under Strict Mode's double effect: a second send would only be refused by the open's limit.
  useEffect(() => {
    if (taken.current) {
      return;
    }
    taken.current = true;
    const token = tokenFromHash(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (token === undefined) {
      setState({ kind: "missing" });
      return;
    }
    void postJson("/v1/public/invitation-open", { token }).then((result) => {
      setState(landingOf(result));
    });
  }, []);

  return (
    <section className={styles.panel} aria-labelledby="invitation-title">
      {state.kind === "found" ? (
        <EventCard language={language} event={state.event} />
      ) : (
        <>
          <h1 id="invitation-title" className={styles.title}>
            {t("invCampaignPage.title")}
          </h1>
          {state.kind === "reading" ? (
            <p role="status" className={styles.muted}>
              {t("common.loading")}
            </p>
          ) : (
            <p role="alert" className={styles.alert}>
              {t(NOTES[state.kind])}
            </p>
          )}
        </>
      )}
    </section>
  );
}
