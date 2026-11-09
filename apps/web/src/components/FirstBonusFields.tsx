"use client";

import {
  FIRST_BONUS_LIMITS,
  formatNumber,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { numberFieldPatch } from "#src/lib/number-field.ts";
import { firstBonusMin, firstBonusNotes } from "#src/lib/first-bonus-fields.ts";
import type { QuestDraft } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input } from "#src/ui/Field.tsx";

type FieldsProps = Readonly<{
  language: Language;
  terms: EventTerms;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
  save: (draft: QuestDraft) => void;
}>;

/**
 * "First players bonus" (T-313, F-342, ADR-262): X extra points for the first N players to finish the quest. Once a
 * real player got it, its points are read-only, N may not go below the number given, and Stop the bonus sets N to
 * that number (the server counts it, so a claim in flight is never refused).
 */
export function FirstBonusFields(props: FieldsProps) {
  const { language, draft, busy, change } = props;
  const t = useTranslator(language);
  const { locked } = firstBonusNotes(draft.firstBonusSaved);
  return (
    <FieldGroup>
      <Checkbox
        label={t("builder.firstBonus.title")}
        checked={draft.firstBonusOn}
        disabled={busy || locked}
        onChange={(event) => change({ firstBonusOn: event.target.checked })}
      />
      {draft.firstBonusOn ? <FirstBonusDetails {...props} /> : null}
    </FieldGroup>
  );
}

function BonusNumber({
  draft,
  busy,
  change,
  field,
  limits,
  label,
  readOnly,
}: Readonly<{
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
  field: "firstBonusPoints" | "firstBonusSlots";
  limits: Readonly<{ min: number; max: number }>;
  label: string;
  readOnly: boolean;
}>) {
  return (
    <Field label={label}>
      <Input
        type="number"
        dir="ltr"
        min={firstBonusMin(field, limits.min, draft.firstBonusSaved)}
        max={limits.max}
        required
        value={draft[field]}
        readOnly={readOnly}
        disabled={busy}
        onChange={(event) => {
          const patch = numberFieldPatch(field, event.target.value);
          if (patch !== null) {
            change(patch);
          }
        }}
      />
    </Field>
  );
}

function FirstBonusDetails({ language, terms, draft, busy, change, save }: FieldsProps) {
  const t = useTranslator(language);
  const saved = draft.firstBonusSaved;
  const notes = firstBonusNotes(saved);
  const given = formatNumber(saved?.given ?? 0, language);
  const shared = { draft, busy, change };
  return (
    <>
      <BonusNumber
        {...shared}
        field="firstBonusPoints"
        limits={FIRST_BONUS_LIMITS.points}
        label={t("builder.firstBonus.points", { currency: termFor(terms.currency, language) })}
        readOnly={notes.locked}
      />
      {notes.locked ? <Muted>{t("builder.firstBonus.locked", { given })}</Muted> : null}
      <BonusNumber
        {...shared}
        field="firstBonusSlots"
        limits={FIRST_BONUS_LIMITS.slots}
        label={t("builder.firstBonus.slots")}
        readOnly={false}
      />
      {notes.belowGiven ? <Muted>{t("builder.firstBonus.belowGiven", { given })}</Muted> : null}
      <Muted>
        {t("builder.firstBonus.preview", {
          slots: formatNumber(draft.firstBonusSlots, language),
          points: formatNumber(draft.firstBonusPoints, language),
          currency: termFor(terms.currency, language, draft.firstBonusPoints),
        })}
      </Muted>
      {notes.canStop ? (
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => save({ ...draft, firstBonusStop: true })}
        >
          {t("builder.firstBonus.stop")}
        </Button>
      ) : null}
    </>
  );
}
