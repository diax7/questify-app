"use client";

import type { Language, MatrixRow } from "@questify/shared";
import { useRef } from "react";
import styles from "#src/components/translations.module.css";
import {
  LANGUAGES,
  canSave,
  chipsOf,
  insertPlaceholder,
  isEdited,
  isInvalid,
  type RowDraft,
} from "#src/lib/console-translations.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { Icon } from "#src/ui/Icon.tsx";

type BoxProps = Readonly<{
  uiLanguage: Language;
  row: MatrixRow;
  code: Language;
  draft: RowDraft;
  busy: boolean;
  onType: (code: Language, text: string) => void;
}>;

/**
 * One language of a key: the box, the shipped text under it and the placeholders of the shipped text as chips. A chip
 * says whether its name is still in the text; one that was lost is put back at the caret with a click, and a name the
 * shipped text does not have is flagged. The save stays off until every name is in place (FR-1767).
 */
function LanguageBox({ uiLanguage, row, code, draft, busy, onType }: BoxProps) {
  const t = translatorFor(uiLanguage);
  const box = useRef<HTMLTextAreaElement>(null);
  const { chips, extra } = chipsOf(row, code, draft[code]);
  const invalid = isEdited(row, draft, code) && isInvalid(row, draft, code);

  const insert = (name: string): void => {
    const field = box.current;
    const at = {
      start: field?.selectionStart ?? draft[code].length,
      end: field?.selectionEnd ?? draft[code].length,
    };
    const next = insertPlaceholder(draft[code], at, name);
    onType(code, next.text);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div data-testid={`box-${code}`}>
      <Field
        label={t(`texts.language.${code}`)}
        help={
          <>
            {t("console.translations.shipped")}:{" "}
            <bdi lang={code} dir={directionOf(code)}>
              {row.shipped[code]}
            </bdi>
          </>
        }
        error={invalid ? t("console.translations.invalid") : undefined}
      >
        <Textarea
          ref={box}
          lang={code}
          dir={directionOf(code)}
          rows={3}
          value={draft[code]}
          disabled={busy}
          onChange={(event) => onType(code, event.target.value)}
        />
      </Field>
      {chips.length + extra.length === 0 ? null : (
        <div
          className={styles.chips}
          role="group"
          aria-label={t("console.translations.placeholders")}
        >
          {chips.map((chip) => (
            <button
              key={chip.name}
              type="button"
              className={styles.chip}
              data-state={chip.state}
              aria-label={t("console.translations.insert", { name: `{${chip.name}}` })}
              disabled={busy}
              onClick={() => insert(chip.name)}
            >
              <Icon name={chip.state === "present" ? "check" : "alert"} />
              {`{${chip.name}}`}
            </button>
          ))}
          {extra.map((name) => (
            <span key={name} className={styles.chip} data-state="extra">
              <Icon name="blocked" />
              {`{${name}}`} {t("console.translations.notAllowed")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The English and Arabic boxes of one key with Save and Discard. */
export function TranslationEditor({
  uiLanguage,
  row,
  draft,
  busy,
  problem,
  onType,
  onSave,
  onDiscard,
}: Readonly<{
  uiLanguage: Language;
  row: MatrixRow;
  draft: RowDraft;
  busy: boolean;
  problem: string | null;
  onType: (code: Language, text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}>) {
  const t = translatorFor(uiLanguage);
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {LANGUAGES.map((code) => (
        <LanguageBox
          key={code}
          uiLanguage={uiLanguage}
          row={row}
          code={code}
          draft={draft}
          busy={busy}
          onType={onType}
        />
      ))}
      <div className={styles.editorTools}>
        <Button type="submit" variant="primary" disabled={busy || !canSave(row, draft)}>
          {t("console.translations.save")}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onDiscard}>
          {t("console.translations.discard")}
        </Button>
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
      </div>
    </form>
  );
}
