"use client";

import type { Language, LevelTitlesAdmin } from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  PairCells,
  RowTools,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  LEVEL_TITLES_API,
  byLevel,
  checkLevelTitles,
  isLevelTitlesDirty,
  levelTitlesDraftOf,
  readLevelTitles,
  type LevelTitleDraft,
} from "#src/lib/console-catalog.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Stack } from "#src/ui/Section.tsx";

const LANGUAGES = ["en", "ar"] as const satisfies readonly Language[];

function TitleFields({
  language,
  index,
  title,
  wrong,
  disabled,
  onChange,
  onRemove,
}: Readonly<{
  language: Language;
  index: number;
  title: LevelTitleDraft;
  wrong: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: LevelTitleDraft) => void;
  onRemove: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <li className={styles.title} data-testid="title-edit">
      <Field
        label={t("console.catalog.levels.from")}
        error={wrong.has(`titles.${index}.levelFrom`) ? t("console.catalog.invalid") : undefined}
      >
        <Input
          inputMode="numeric"
          dir="ltr"
          value={title.levelFrom}
          disabled={disabled}
          onChange={(event) => onChange({ ...title, levelFrom: event.target.value })}
        />
      </Field>
      {LANGUAGES.map((code) => (
        <Field
          key={code}
          label={t(`texts.language.${code}`)}
          error={
            wrong.has(`titles.${index}.name.${code}`) ? t("console.catalog.invalid") : undefined
          }
        >
          <Input
            lang={code}
            dir={directionOf(code)}
            value={title.name[code]}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...title, name: { ...title.name, [code]: event.target.value } })
            }
          />
        </Field>
      ))}
      <IconButton
        icon="trash"
        label={t("console.catalog.levels.remove", { level: title.levelFrom })}
        disabled={disabled}
        onClick={onRemove}
      />
    </li>
  );
}

function TitlesEditor({
  language,
  catalog,
  set,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<LevelTitlesAdmin>;
  set: LevelTitlesAdmin;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [titles, setTitles] = useState<LevelTitleDraft[]>(() => levelTitlesDraftOf(set));
  const checked = checkLevelTitles(titles);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const replace = (index: number, next: LevelTitleDraft): void =>
    setTitles(titles.map((title, at) => (at === index ? next : title)));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          void catalog.save("", checked.doc).then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        <ul className={styles.titles}>
          {titles.map((title, index) => (
            <TitleFields
              key={index}
              language={language}
              index={index}
              title={title}
              wrong={wrong}
              disabled={catalog.busy}
              onChange={(next) => replace(index, next)}
              onRemove={() => setTitles(titles.filter((_, at) => at !== index))}
            />
          ))}
        </ul>
        {wrong.has("titles") ? (
          <Muted role="status">{t("console.catalog.levels.needFirst")}</Muted>
        ) : null}
        <div>
          <Button
            variant="secondary"
            disabled={catalog.busy}
            onClick={() => setTitles([...titles, { levelFrom: "", name: { ar: "", en: "" } }])}
          >
            {t("console.catalog.levels.add")}
          </Button>
        </div>
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && isLevelTitlesDirty(set, titles)}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

/**
 * The level titles (T-709b, FR-1403): the whole set is one document, edited as a list of ranges (a title covers the levels
 * from its own up to the next one's) and saved at once, so level 1 always has a title.
 */
export function CatalogLevelTitles({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, LEVEL_TITLES_API, readLevelTitles);
  const [editing, setEditing] = useState(false);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(set) => (
          <section className={styles.card} data-testid="level-titles" data-editing={editing}>
            <div className={styles.head}>
              <span className={styles.name}>
                {t("console.catalog.tab.levels")}
                {set.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
              </span>
              <RowTools
                language={language}
                name={t("console.catalog.tab.levels")}
                busy={catalog.busy}
                open={editing}
                revertible={set.revertible}
                onEdit={() => setEditing(true)}
                onRevert={() => void catalog.revert("")}
              />
            </div>
            {editing ? (
              <TitlesEditor
                language={language}
                catalog={catalog}
                set={set}
                onDone={() => setEditing(false)}
              />
            ) : (
              <ul className={styles.titles}>
                {byLevel(levelTitlesDraftOf(set)).map((title) => (
                  <li key={title.levelFrom} data-testid="title-row">
                    <p className={styles.tag}>
                      {t("console.catalog.levels.range", { level: title.levelFrom })}
                    </p>
                    <PairCells language={language} value={title.name} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CatalogState>
    </Stack>
  );
}
