"use client";

import {
  FIRST_BONUS_LIMITS,
  formatNumber,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { QuestDraft } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/**
 * "First players bonus" (T-313, F-342, ADR-262): X extra points for the first N players to finish the quest. Once a
 * real player got it, its points are read-only, N may not go below the number given, and Stop the bonus sets N to
 * that number (the server counts it, so a claim in flight is never refused).
 */
export function FirstBonusFields({
  language,
  terms,
  draft,
  busy,
  change,
  save,
}: Readonly<{
  language: Language;
  terms: EventTerms;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
  save: (draft: QuestDraft) => void;
}>) {
  const t = useTranslator(language);
  const saved = draft.firstBonusSaved;
  const locked = saved?.locked === true;
  const currency = termFor(terms.currency, language);
  const number = (
    key: "firstBonusPoints" | "firstBonusSlots",
    limits: Readonly<{ min: number; max: number }>,
    label: string,
    readOnly: boolean,
  ) => (
    <label className={styles.field}>
      {label}
      <input
        className={styles.input}
        type="number"
        dir="ltr"
        min={key === "firstBonusSlots" ? Math.max(limits.min, saved?.given ?? 0) : limits.min}
        max={limits.max}
        required
        value={draft[key]}
        readOnly={readOnly}
        disabled={busy}
        onChange={(event) => {
          if (event.target.value !== "") {
            change({ [key]: Number(event.target.value) });
          }
        }}
      />
    </label>
  );
  return (
    <div className={styles.choices}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.firstBonusOn}
          disabled={busy || locked}
          onChange={(event) => change({ firstBonusOn: event.target.checked })}
        />
        <span>{t("builder.firstBonus.title")}</span>
      </label>
      {draft.firstBonusOn ? (
        <>
          {number(
            "firstBonusPoints",
            FIRST_BONUS_LIMITS.points,
            t("builder.firstBonus.points", { currency }),
            locked,
          )}
          {locked ? (
            <p className={styles.muted}>
              {t("builder.firstBonus.locked", { given: formatNumber(saved.given, language) })}
            </p>
          ) : null}
          {number(
            "firstBonusSlots",
            FIRST_BONUS_LIMITS.slots,
            t("builder.firstBonus.slots"),
            false,
          )}
          {saved !== null && saved.given > 0 ? (
            <p className={styles.muted}>
              {t("builder.firstBonus.belowGiven", { given: formatNumber(saved.given, language) })}
            </p>
          ) : null}
          <p className={styles.muted}>
            {t("builder.firstBonus.preview", {
              slots: formatNumber(draft.firstBonusSlots, language),
              points: formatNumber(draft.firstBonusPoints, language),
              currency: termFor(terms.currency, language, draft.firstBonusPoints),
            })}
          </p>
          {saved !== null && saved.left > 0 ? (
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => save({ ...draft, firstBonusStop: true })}
            >
              {t("builder.firstBonus.stop")}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
