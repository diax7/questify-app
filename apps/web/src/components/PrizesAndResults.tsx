"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { PrizesPanel } from "#src/components/PrizesPanel.tsx";
import { ResultsPanel } from "#src/components/ResultsPanel.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

type EventFacts = Readonly<{ timezone: string; joinCode: string | null; statusNow: string }>;

/** The Prizes and results page (T-214): the event is read once for its zone, its code and whether it is live. */
export function PrizesAndResults({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const [event, setEvent] = useState<EventFacts | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}`).then((result) => {
      const read = result.ok ? (result.body as { event?: Partial<EventFacts> }).event : undefined;
      if (read === undefined || typeof read.timezone !== "string") {
        setFailed(true);
        return;
      }
      setEvent({
        timezone: read.timezone,
        joinCode: typeof read.joinCode === "string" ? read.joinCode : null,
        statusNow: String(read.statusNow),
      });
    });
  }, [organizerId, eventId]);
  if (event === null) {
    return failed ? (
      <p role="alert" className={styles.alert}>
        {t("prizes.loadFailed")}
      </p>
    ) : (
      <p className={styles.muted}>{t("common.loading")}</p>
    );
  }
  const live = ["live", "ended", "archived"].includes(event.statusNow);
  return (
    <>
      <PrizesPanel
        language={language}
        organizerId={organizerId}
        eventId={eventId}
        joinCode={event.joinCode}
        live={live}
      />
      <ResultsPanel
        language={language}
        organizerId={organizerId}
        eventId={eventId}
        timeZone={event.timezone}
        owner={myRole === "owner"}
      />
    </>
  );
}
