"use client";

import type { AchievementAdmin, Language } from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  PairCells,
  PairInputs,
  RowTools,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  ACHIEVEMENTS_API,
  achievementDraftOf,
  checkAchievement,
  isAchievementDirty,
  readAchievements,
  type AchievementDraft,
} from "#src/lib/console-catalog.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

const TIERS = ["bronze", "silver", "gold"] as const;

function AchievementEditor({
  language,
  catalog,
  row,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<AchievementAdmin[]>;
  row: AchievementAdmin;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<AchievementDraft>(() => achievementDraftOf(row));
  const checked = checkAchievement(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          void catalog.save(row.id, checked.doc).then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        <PairInputs
          language={language}
          label={t("console.catalog.achievements.name")}
          field="name"
          value={draft.name}
          invalid={wrong}
          disabled={catalog.busy}
          onChange={(name) => setDraft({ ...draft, name })}
        />
        <div className={styles.fields}>
          {TIERS.map((tier) => (
            <Field
              key={tier}
              label={t(`console.catalog.achievements.${tier}`)}
              error={wrong.has(tier) ? t("console.catalog.achievements.rise") : undefined}
            >
              <Input
                inputMode="numeric"
                dir="ltr"
                value={draft[tier]}
                disabled={catalog.busy}
                onChange={(event) => setDraft({ ...draft, [tier]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && isAchievementDirty(row, draft)}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function AchievementCard({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<AchievementAdmin[]>; row: AchievementAdmin }>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState(false);
  return (
    <li
      className={styles.card}
      data-testid="achievement-card"
      data-id={row.id}
      data-editing={editing}
    >
      <div className={styles.head}>
        <span className={styles.name}>
          {t(`console.catalog.achievements.metric.${row.metric}`)}
          {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={row.name[language]}
          busy={catalog.busy}
          open={editing}
          revertible={row.revertible}
          onEdit={() => setEditing(true)}
          onRevert={() => void catalog.revert(row.id)}
        />
      </div>
      {editing ? (
        <AchievementEditor
          language={language}
          catalog={catalog}
          row={row}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <PairCells language={language} value={row.name} />
          <p className={styles.facts} dir="ltr">
            {TIERS.map((tier) => `${t(`console.catalog.achievements.${tier}`)} ${row[tier]}`).join(
              " · ",
            )}
          </p>
        </>
      )}
    </li>
  );
}

/**
 * The achievements (T-709b, FR-1403): five equal cards with the name in both languages and the three tier thresholds. A
 * tier a player already earned stays earned whatever the numbers become.
 */
export function CatalogAchievements({ language }: Readonly<{ language: Language }>) {
  const catalog = useCatalog(language, ACHIEVEMENTS_API, readAchievements);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <ul className={styles.cards}>
            {rows.map((row) => (
              <AchievementCard key={row.id} language={language} catalog={catalog} row={row} />
            ))}
          </ul>
        )}
      </CatalogState>
    </Stack>
  );
}
