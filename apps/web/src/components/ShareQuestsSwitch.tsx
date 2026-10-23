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
 * The event's share quests switch (FR-219, ADR-199): on by default; off hides every share quest from players and stops
 * paying them. The owner changes it; an editor sees which it is. Saved as soon as the box changes.
 */
export function ShareQuestsSwitch({ language, organizerId, eventId, initial, myRole }: Props) {
  const t = translatorFor(language);
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (enabled: boolean) => {
    const before = on;
    setOn(enabled);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/share-quests`,
      { enabled },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setOn(before);
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setOn((result.body as { shareQuests?: unknown }).shareQuests === true);
  };

  return (
    <section className={styles.card} aria-labelledby="share-quests-title">
      <h2 id="share-quests-title" className={styles.subtitle}>
        {t("events.shareQuests.title")}
      </h2>
      {myRole === "owner" ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            onChange={(changed) => void save(changed.target.checked)}
          />
          <span>{t("events.shareQuests.label")}</span>
        </label>
      ) : null}
      <p role="status" className={styles.muted}>
        {t(on ? "events.shareQuests.on" : "events.shareQuests.off")}{" "}
        {myRole === "owner" ? null : t("events.ranking.ownerOnly")}
      </p>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
    </section>
  );
}
