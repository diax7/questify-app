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
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input } from "#src/ui/Field.tsx";

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
    <Field label={label}>
      <Input
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
    </Field>
  );
  return (
    <FieldGroup>
      <Checkbox
        label={t("builder.firstBonus.title")}
        checked={draft.firstBonusOn}
        disabled={busy || locked}
        onChange={(event) => change({ firstBonusOn: event.target.checked })}
      />
      {draft.firstBonusOn ? (
        <>
          {number(
            "firstBonusPoints",
            FIRST_BONUS_LIMITS.points,
            t("builder.firstBonus.points", { currency }),
            locked,
          )}
          {locked ? (
            <Muted>
              {t("builder.firstBonus.locked", { given: formatNumber(saved.given, language) })}
            </Muted>
          ) : null}
          {number(
            "firstBonusSlots",
            FIRST_BONUS_LIMITS.slots,
            t("builder.firstBonus.slots"),
            false,
          )}
          {saved !== null && saved.given > 0 ? (
            <Muted>
              {t("builder.firstBonus.belowGiven", { given: formatNumber(saved.given, language) })}
            </Muted>
          ) : null}
          <Muted>
            {t("builder.firstBonus.preview", {
              slots: formatNumber(draft.firstBonusSlots, language),
              points: formatNumber(draft.firstBonusPoints, language),
              currency: termFor(terms.currency, language, draft.firstBonusPoints),
            })}
          </Muted>
          {saved !== null && saved.left > 0 ? (
            <Button
              variant="quiet"

              disabled={busy}
              onClick={() => save({ ...draft, firstBonusStop: true })}
            >
              {t("builder.firstBonus.stop")}
            </Button>
          ) : null}
        </>
      ) : null}
    </FieldGroup>
  );
}
