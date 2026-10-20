"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  /** The event's switch as the page last read it. */
  initial: boolean;
  myRole: "owner" | "editor";
}>;

/**
 * The event's ranking switch (FR-607): the owner hides the ranking from players and shows it again; an editor sees
 * which it is. The change is saved as soon as the box is ticked or cleared.
 */
export function RankingSwitch({ language, organizerId, eventId, initial, myRole }: Props) {
  const t = translatorFor(language);
  const [shown, setShown] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (enabled: boolean) => {
    const before = shown;
    // The box changes at once; a refused save puts it back and says why.
    setShown(enabled);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/ranking`,
      { enabled },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setShown(before);
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setShown((result.body as { ranking?: unknown }).ranking === true);
  };

  return (
    <section className={styles.card} aria-labelledby="ranking-title">
      <h2 id="ranking-title" className={styles.subtitle}>
        {t("events.ranking.title")}
      </h2>
      {myRole === "owner" ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={shown}
            disabled={busy}
            onChange={(changed) => void save(changed.target.checked)}
          />
          <span>{t("events.ranking.label")}</span>
        </label>
      ) : null}
      <p role="status" className={styles.muted}>
        {t(shown ? "events.ranking.shown" : "events.ranking.hidden")}{" "}
        {myRole === "owner" ? t("events.ranking.hint") : t("events.ranking.ownerOnly")}
      </p>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
    </section>
  );
}
