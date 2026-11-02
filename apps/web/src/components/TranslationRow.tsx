"use client";

import { shownText, type Language, type MatrixRow } from "@questify/shared";
import { TranslationEditor } from "#src/components/TranslationEditor.tsx";
import styles from "#src/components/translations.module.css";
import { LANGUAGES, isChanged } from "#src/lib/console-translations.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import type { Editing } from "#src/lib/use-translation-edit.ts";
import { Badge } from "#src/ui/Feedback.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";

/** One language of a key as players see it, with the shipped text beneath it when an admin changed it. */
function Cell({
  uiLanguage,
  row,
  code,
}: Readonly<{ uiLanguage: Language; row: MatrixRow; code: Language }>) {
  const t = translatorFor(uiLanguage);
  const stored = row.stored[code];
  const changed = stored !== null && !row.stale[code];
  return (
    <div className={styles.cell} data-testid={`cell-${code}`} data-changed={changed}>
      <span className={styles.tag}>
        {t(`texts.language.${code}`)}
        {changed ? <Badge tone="info">{t("console.translations.changed")}</Badge> : null}
        {row.stale[code] ? <Badge tone="warning">{t("console.translations.stale")}</Badge> : null}
      </span>
      <span className={styles.text} lang={code} dir={directionOf(code)}>
        {shownText(row, code)}
      </span>
      {changed ? (
        <span className={styles.note}>
          {t("console.translations.shipped")}:{" "}
          <bdi lang={code} dir={directionOf(code)}>
            {row.shipped[code]}
          </bdi>
        </span>
      ) : null}
      {row.stale[code] && stored !== null ? (
        <span className={styles.note}>
          {t("console.translations.staleNote")}:{" "}
          <bdi lang={code} dir={directionOf(code)}>
            {stored}
          </bdi>
        </span>
      ) : null}
    </div>
  );
}

/**
 * One key of the matrix: its name, English and Arabic side by side with the shipped text kept in view for a changed one,
 * and an edit and a revert button. A legal or consent text is marked read-only and has neither. While it is being
 * edited the two texts become boxes.
 */
export function TranslationRow({
  uiLanguage,
  row,
  editing,
  busy,
  problem,
  onEdit,
  onRevert,
  onType,
  onSave,
  onDiscard,
}: Readonly<{
  uiLanguage: Language;
  row: MatrixRow;
  editing: Editing | null;
  busy: boolean;
  problem: string | null;
  onEdit: () => void;
  onRevert: () => void;
  onType: (code: Language, text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}>) {
  const t = translatorFor(uiLanguage);
  const open = editing?.row.key === row.key;
  const changed = isChanged(row);
  return (
    <li className={styles.row} data-testid="translation-row" data-key={row.key} data-editing={open}>
      <div className={styles.key}>
        <code className={styles.keyName} dir="ltr">
          {row.key}
        </code>
        {row.locked ? <Badge>{t("console.translations.locked")}</Badge> : null}
      </div>
      {open && editing !== null ? (
        <TranslationEditor
          uiLanguage={uiLanguage}
          row={row}
          draft={editing.draft}
          busy={busy}
          problem={problem}
          onType={onType}
          onSave={onSave}
          onDiscard={onDiscard}
        />
      ) : (
        LANGUAGES.map((code) => <Cell key={code} uiLanguage={uiLanguage} row={row} code={code} />)
      )}
      {row.locked ? null : (
        <div className={styles.tools}>
          <IconButton
            icon="edit"
            label={t("console.translations.edit", { key: row.key })}
            disabled={busy || open}
            onClick={onEdit}
          />
          <IconButton
            icon="undo"
            label={t("console.translations.revert", { key: row.key })}
            disabled={busy || !changed}
            onClick={onRevert}
          />
        </div>
      )}
    </li>
  );
}
