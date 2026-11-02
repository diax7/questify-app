"use client";

import type { Language } from "@questify/shared";
import { useState, type ReactNode } from "react";
import { Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import { revertPath, rowPath, type Pair } from "#src/lib/console-catalog.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { useConsoleRead, type ConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

const LANGUAGES = ["en", "ar"] as const satisfies readonly Language[];

export type Catalog<Rows> = Readonly<{
  state: ConsoleRead<Rows>;
  reload: () => Promise<void>;
  busy: boolean;
  problem: string | null;
  notice: string | null;
  /**
   * Saves `doc` at `id` (empty for a single document) and reloads the list when the API accepted it. `handled` takes a
   * refusal the tab answers itself (an achievement lowering's confirmation).
   */
  save: (id: string, doc: unknown, handled?: Handled) => Promise<boolean>;
  revert: (id: string, body?: object, handled?: Handled) => Promise<boolean>;
}>;

type Handled = (result: PostResult) => boolean;

/**
 * One catalog tab's data: the list read from `base`, and its writes. A save or a revert answers with the row, but the
 * list is read again instead, so what is on screen is always what the database holds now.
 */
export function useCatalog<Rows>(
  language: Language,
  base: string,
  read: (body: unknown) => Rows | undefined,
): Catalog<Rows> {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(base, read);
  const [notice, setNotice] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  const target = (id: string): string => (id === "" ? base : rowPath(base, id));
  return {
    state,
    reload,
    busy: write.busy,
    problem: write.problem,
    notice,
    save: (id, doc, handled) =>
      write.run(
        () => requestJson("PUT", target(id), doc, keyed()),
        t("console.catalog.saved"),
        handled,
      ),
    revert: (id, body = {}, handled = undefined) =>
      write.run(
        () => requestJson("POST", revertPath(target(id)), body, keyed()),
        t("console.catalog.reverted"),
        handled,
      ),
  };
}

/** What a tab shows while its list loads or when it could not: the list itself when it is ready. */
export function CatalogState<Rows>({
  language,
  catalog,
  children,
}: Readonly<{
  language: Language;
  catalog: Pick<Catalog<Rows>, "state" | "reload" | "notice" | "problem">;
  children: (rows: Rows) => ReactNode;
}>) {
  const t = translatorFor(language);
  const { state } = catalog;
  return (
    <>
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.catalog.loadFailed")}{" "}
          <Button size="sm" onClick={() => void catalog.reload()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {catalog.notice === null ? null : (
        <Notice tone="success" role="status">
          {catalog.notice}
        </Notice>
      )}
      <Problem problem={catalog.problem} />
      {state.kind === "ready" ? children(state.value) : null}
    </>
  );
}

/** A text in both languages, side by side (English first, as the app texts page), each in its own direction. */
export function PairCells({
  language,
  value,
  label,
}: Readonly<{ language: Language; value: Pair; label?: ReactNode }>) {
  const t = translatorFor(language);
  return (
    <div className={styles.pair}>
      {LANGUAGES.map((code) => (
        <div key={code} className={styles.cell} data-testid={`cell-${code}`}>
          <span className={styles.tag}>
            {label === undefined ? null : <>{label} · </>}
            {t(`texts.language.${code}`)}
          </span>
          <span className={styles.text} lang={code} dir={directionOf(code)}>
            {value[code]}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The two boxes of a text in both languages. `invalid` names a language whose text the check refused. */
export function PairInputs({
  language,
  label,
  field,
  value,
  invalid,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  label: string;
  /** The field's name in the check, such as `name`; a refused language is `name.ar`. */
  field: string;
  value: Pair;
  invalid: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: Pair) => void;
}>) {
  const t = translatorFor(language);
  return (
    <div className={styles.pair}>
      {LANGUAGES.map((code) => (
        <Field
          key={code}
          label={`${label} · ${t(`texts.language.${code}`)}`}
          error={invalid.has(`${field}.${code}`) ? t("console.catalog.invalid") : undefined}
        >
          <Input
            lang={code}
            dir={directionOf(code)}
            value={value[code]}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [code]: event.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

/** The edit and revert buttons of a row. The revert is there only when the row has an earlier version to go back to. */
export function RowTools({
  language,
  name,
  busy,
  open,
  revertible,
  onEdit,
  onRevert,
}: Readonly<{
  language: Language;
  name: string;
  busy: boolean;
  open: boolean;
  revertible: boolean;
  onEdit: () => void;
  onRevert: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <div className={styles.tools}>
      <IconButton
        icon="edit"
        label={t("console.catalog.edit", { name })}
        disabled={busy || open}
        onClick={onEdit}
      />
      <IconButton
        icon="undo"
        label={t("console.catalog.revert", { name })}
        disabled={busy || !revertible}
        onClick={onRevert}
      />
    </div>
  );
}

/** Save and Discard under an editor. */
export function EditorButtons({
  language,
  busy,
  canSave,
  onDiscard,
}: Readonly<{ language: Language; busy: boolean; canSave: boolean; onDiscard: () => void }>) {
  const t = translatorFor(language);
  return (
    <Toolbar>
      <Button type="submit" disabled={busy || !canSave}>
        {t("console.catalog.save")}
      </Button>
      <Button variant="quiet" disabled={busy} onClick={onDiscard}>
        {t("console.catalog.discard")}
      </Button>
    </Toolbar>
  );
}
