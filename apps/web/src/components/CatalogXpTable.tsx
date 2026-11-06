"use client";

import {
  formatNumber,
  type ItemAdmin,
  type Language,
  type XpTableAdmin,
  type XpTableDoc,
  type XpTableLowering,
  type XpTablePreview,
} from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  RowTools,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  ITEMS_API,
  XP_PREVIEW_API,
  XP_TABLE_API,
  canRemoveTop,
  checkXpTable,
  isBusy,
  isXpTableDirty,
  readItems,
  readPreview,
  readXpTable,
  rewardChoices,
  withLevelAdded,
  xpDraftOf,
  xpLoweringOf,
  type XpRowDraft,
} from "#src/lib/console-catalog-xp.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

type Items = readonly ItemAdmin[];

const nameOf = (items: Items, id: string | null, language: Language): string | undefined =>
  items.find((item) => item.id === id)?.name[language];

/** The lock of a level someone reached: its reward stays and it cannot be removed. */
function LockMark({ language, level }: Readonly<{ language: Language; level: number }>) {
  const label = translatorFor(language)("console.catalog.xp.locked", { level });
  return (
    <span role="img" aria-label={label} title={label} data-testid="xp-locked">
      <Icon name="lock" />
    </span>
  );
}

/**
 * What a save does, from the preview: about how many go up, and how many go down. A revert that lowers the curve has no
 * preview; it says which levels it lowers, from the API's refusal (`lowering`).
 */
function PreviewLines({
  language,
  preview,
  lowering,
}: Readonly<{
  language: Language;
  preview: XpTablePreview | null;
  lowering: XpTableLowering | null;
}>) {
  const t = translatorFor(language);
  if (lowering !== null) {
    return (
      <p data-testid="xp-lowering">
        {t("console.catalog.xp.lowering", {
          levels: lowering.levels
            .map((level) => formatNumber(level, language))
            .join(language === "ar" ? "، " : ", "),
        })}
      </p>
    );
  }
  if (preview === null) {
    return <p>{t("console.catalog.lower.undo")}</p>;
  }
  return (
    <>
      {preview.up > 0 ? (
        <p data-testid="xp-up">
          {t("console.catalog.xp.up", { up: formatNumber(preview.up, language) })}
        </p>
      ) : null}
      {preview.down > 0 ? (
        <p data-testid="xp-down">
          {t("console.catalog.xp.down", { down: formatNumber(preview.down, language) })}
        </p>
      ) : null}
    </>
  );
}

/**
 * The one confirmation of a save (ADR-440): about how many players go up and get their level rewards at their next sync, about
 * how many go down and keep what they earned, then the save with the confirmation. The numbers are the preview's, so the
 * console says "about".
 */
function SaveConfirm({
  language,
  preview,
  lowering,
  busy,
  onSave,
  onCancel,
}: Readonly<{
  language: Language;
  preview: XpTablePreview | null;
  lowering: XpTableLowering | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}>) {
  const t = translatorFor(language);
  const pays = preview === null || preview.levels > 0;
  return (
    <Notice tone="warning" as="div" role="alert">
      <Stack>
        <strong>{t("console.catalog.xp.confirm")}</strong>
        <PreviewLines language={language} preview={preview} lowering={lowering} />
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant={pays ? "danger" : "primary"} disabled={busy} onClick={onSave}>
            {pays ? t("console.catalog.xp.pay") : t("console.catalog.save")}
          </Button>
        </Toolbar>
      </Stack>
    </Notice>
  );
}

function LevelFields({
  language,
  row,
  items,
  rows,
  wrong,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  row: XpRowDraft;
  items: Items;
  rows: readonly XpRowDraft[];
  wrong: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: XpRowDraft) => void;
}>) {
  const t = translatorFor(language);
  const index = row.level - 1;
  const first = row.level === 1;
  return (
    <li className={styles.level} data-testid="xp-level-edit" data-level={row.level}>
      <span className={styles.name}>{t("console.catalog.xp.level", { level: row.level })}</span>
      <Field
        label={t("console.catalog.xp.start")}
        error={wrong.has(`levels.${index}.xpFrom`) ? t("console.catalog.invalid") : undefined}
      >
        <Input
          inputMode="numeric"
          dir="ltr"
          value={row.xpFrom}
          disabled={disabled || first}
          onChange={(event) => onChange({ ...row, xpFrom: event.target.value })}
        />
      </Field>
      <Field
        label={t("console.catalog.xp.reward")}
        error={wrong.has(`levels.${index}.itemId`) ? t("console.catalog.invalid") : undefined}
      >
        <Select
          value={row.itemId ?? ""}
          disabled={disabled || first || row.reached}
          onChange={(event) => onChange({ ...row, itemId: event.target.value || null })}
        >
          <option value="">{t("console.catalog.xp.noReward")}</option>
          {rewardChoices(items, rows, row.itemId).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name[language]}
            </option>
          ))}
        </Select>
      </Field>
      {row.reached ? <LockMark language={language} level={row.level} /> : null}
    </li>
  );
}

/**
 * The confirmation a save asks for: the preview of what the table does to players (`asking`), and the notice when the
 * preview could not be had (the server is busy with level-ups, or the read failed).
 */
function useXpPreview(language: Language) {
  const [asking, setAsking] = useState<Readonly<{
    doc: XpTableDoc;
    preview: XpTablePreview;
  }> | null>(null);
  const [busyNote, setBusyNote] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busyAware = (result: PostResult): boolean => {
    setBusyNote(isBusy(result.status, result.body));
    return isBusy(result.status, result.body);
  };
  const ask = async (doc: XpTableDoc) => {
    setProblem(null);
    const answer = await requestJson("POST", XP_PREVIEW_API, doc);
    const preview = answer.ok ? readPreview(answer.body) : undefined;
    if (preview !== undefined) {
      setBusyNote(false);
      setAsking({ doc, preview });
    } else if (!busyAware(answer)) {
      setProblem(describeProblem(answer.body, language, translatorFor(language)).text);
    }
  };
  return { asking, setAsking, busyNote, problem, busyAware, ask };
}

function PreviewNotices({
  t,
  busy,
  problem,
}: Readonly<{ t: Translate; busy: boolean; problem: string | null }>) {
  return (
    <>
      {busy ? (
        <Notice tone="warning" role="status">
          {t("console.catalog.xp.busy")}
        </Notice>
      ) : null}
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </>
  );
}

function XpEditor({
  language,
  catalog,
  table,
  items,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<XpTableAdmin>;
  table: XpTableAdmin;
  items: Items;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [rows, setRows] = useState<XpRowDraft[]>(() => xpDraftOf(table));
  const { asking, setAsking, busyNote, problem, busyAware, ask } = useXpPreview(language);
  const checked = checkXpTable(rows);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const save = (doc: XpTableDoc) =>
    catalog.save("", { ...doc, confirmed: true }, busyAware).then((saved) => {
      setAsking(null);
      if (saved) onDone();
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) void ask(checked.doc);
      }}
    >
      <Stack>
        <ol className={styles.levels}>
          {rows.map((row) => (
            <LevelFields
              key={row.level}
              language={language}
              row={row}
              items={items}
              rows={rows}
              wrong={wrong}
              disabled={catalog.busy}
              onChange={(next) => setRows(rows.map((at) => (at.level === next.level ? next : at)))}
            />
          ))}
        </ol>
        <Toolbar>
          <Button
            variant="secondary"
            disabled={catalog.busy || rows.length >= 100}
            onClick={() => setRows(withLevelAdded(rows))}
          >
            {t("console.catalog.xp.add")}
          </Button>
          <Button
            variant="secondary"
            disabled={catalog.busy || !canRemoveTop(rows)}
            onClick={() => setRows(rows.slice(0, -1))}
          >
            {t("console.catalog.xp.removeTop")}
          </Button>
        </Toolbar>
        <PreviewNotices t={t} busy={busyNote} problem={problem} />
        {asking === null ? null : (
          <SaveConfirm
            language={language}
            preview={asking.preview}
            lowering={null}
            busy={catalog.busy}
            onSave={() => void save(asking.doc)}
            onCancel={() => setAsking(null)}
          />
        )}
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && isXpTableDirty(table, rows) && asking === null}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function XpRows({
  language,
  table,
  items,
}: Readonly<{ language: Language; table: XpTableAdmin; items: Items }>) {
  const t = translatorFor(language);
  return (
    <ol className={styles.levels}>
      {table.levels.map((row) => (
        <li key={row.level} className={styles.level} data-testid="xp-level" data-level={row.level}>
          <span className={styles.name}>{t("console.catalog.xp.level", { level: row.level })}</span>
          <span dir="ltr">{formatNumber(row.xpFrom, language)}</span>
          <span>
            {row.itemId === null
              ? t("console.catalog.xp.noReward")
              : (nameOf(items, row.itemId, language) ?? row.itemId)}
          </span>
          {row.reached ? <LockMark language={language} level={row.level} /> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The XP table (T-709d, FR-1403, ADR-440): every level's start in XP and the item it gives, one document saved at once. A
 * level anyone reached keeps its reward and cannot be removed (a lock icon). A save shows what it does first (about how
 * many players go up, how many go down) and pays only once confirmed; a revert that lowers asks too.
 */
export function CatalogXpTable({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, XP_TABLE_API, readXpTable);
  const { state: itemsState } = useConsoleRead(ITEMS_API, readItems);
  const items: Items = itemsState.kind === "ready" ? itemsState.value : [];
  const [editing, setEditing] = useState(false);
  const [revertAsk, setRevertAsk] = useState<XpTableLowering | null>(null);
  const revert = (confirmed: boolean) =>
    catalog.revert("", confirmed ? { confirmed } : {}, (result) => {
      const lowering = xpLoweringOf(result.body);
      setRevertAsk(lowering ?? null);
      return lowering !== undefined;
    });
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(table) => (
          <section className={styles.card} data-testid="xp-table" data-editing={editing}>
            <div className={styles.head}>
              <span className={styles.name}>
                {t("console.catalog.tab.xp")}
                {table.revertible ? (
                  <Badge tone="info">{t("console.catalog.changed")}</Badge>
                ) : null}
              </span>
              <RowTools
                language={language}
                name={t("console.catalog.tab.xp")}
                busy={catalog.busy}
                open={editing}
                revertible={table.revertible}
                onEdit={() => setEditing(true)}
                onRevert={() => void revert(false)}
              />
            </div>
            {revertAsk === null ? null : (
              <SaveConfirm
                language={language}
                preview={null}
                lowering={revertAsk}
                busy={catalog.busy}
                onSave={() => void revert(true).then(() => setRevertAsk(null))}
                onCancel={() => setRevertAsk(null)}
              />
            )}
            {editing ? (
              <XpEditor
                language={language}
                catalog={catalog}
                table={table}
                items={items}
                onDone={() => setEditing(false)}
              />
            ) : (
              <XpRows language={language} table={table} items={items} />
            )}
          </section>
        )}
      </CatalogState>
    </Stack>
  );
}
