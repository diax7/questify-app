"use client";

import {
  AMOUNT_RANGES,
  GEM_AMOUNTS,
  XP_AMOUNTS,
  formatNumber,
  type AmountGroup,
  type AmountsAdmin,
  type AmountsDoc,
  type Language,
} from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  AMOUNTS_API,
  amountChanges,
  amountLabel,
  amountsDraftOf,
  checkAmounts,
  readAmounts,
  type AmountsDraft,
} from "#src/lib/console-catalog.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

const GROUP_FIELDS = { xp: XP_AMOUNTS, gems: GEM_AMOUNTS } as const;

/** One card of number fields: each field's range is its own min and max (ADR-370: no help line). */
function AmountCard({
  language,
  group,
  draft,
  wrong,
  busy,
  onChange,
}: Readonly<{
  language: Language;
  group: AmountGroup;
  draft: AmountsDraft;
  wrong: ReadonlySet<string>;
  busy: boolean;
  onChange: (next: AmountsDraft) => void;
}>) {
  const t = translatorFor(language);
  const values = draft[group] as Readonly<Record<string, string>>;
  const ranges = AMOUNT_RANGES[group] as Readonly<Record<string, readonly [number, number]>>;
  return (
    <li className={styles.card} data-testid="amounts-card" data-group={group}>
      <div className={styles.head}>
        <span className={styles.name}>{t(`console.catalog.amounts.${group}`)}</span>
      </div>
      <div className={styles.fields}>
        {GROUP_FIELDS[group].map((field) => {
          const [low, high] = ranges[field] ?? [0, 0];
          return (
            <Field
              key={field}
              label={t(amountLabel(group, field))}
              error={wrong.has(`${group}.${field}`) ? t("console.catalog.invalid") : undefined}
            >
              <Input
                type="number"
                inputMode="numeric"
                dir="ltr"
                min={low}
                max={high}
                step={1}
                value={values[field] ?? ""}
                disabled={busy}
                data-field={field}
                onChange={(event) =>
                  onChange({ ...draft, [group]: { ...values, [field]: event.target.value } })
                }
              />
            </Field>
          );
        })}
      </div>
    </li>
  );
}

/** What the confirmation says and does: a save names each changed amount, a revert says what coming back means. */
type AmountsAsk = Readonly<{
  title: string;
  lines: readonly Readonly<{ key: string; text: string }>[];
  applyLabel: string;
  apply: () => void;
}>;

/** The words of a save's confirmation: each changed amount, old to new, from now on. */
function saveAsk(
  language: Language,
  row: AmountsAdmin,
  doc: AmountsDoc,
  apply: () => void,
): AmountsAsk {
  const t = translatorFor(language);
  return {
    title: t("console.catalog.amounts.confirm"),
    lines: amountChanges(row, doc).map((change) => ({
      key: `${change.group}.${change.field}`,
      text: t(`console.catalog.amounts.line.${change.group}`, {
        name: t(amountLabel(change.group, change.field)),
        old: formatNumber(change.from, language),
        new: formatNumber(change.to, language),
      }),
    })),
    applyLabel: t("console.catalog.amounts.apply"),
    apply,
  };
}

/** The words of a revert's confirmation: the amounts before the last change pay from now on. */
function revertAsk(language: Language, apply: () => void): AmountsAsk {
  const t = translatorFor(language);
  return {
    title: t("console.catalog.amounts.revertConfirm"),
    lines: [{ key: "revert", text: t("console.catalog.amounts.revertLine") }],
    applyLabel: t("console.catalog.amounts.revertApply"),
    apply,
  };
}

/** Which confirmation is open: a save of the typed amounts, a revert to the earlier ones, or none. */
type Asking = "save" | "revert" | null;

/** The words and the action of the open confirmation, or null when none is open or the typed amounts are not valid. */
function askFor(
  asking: Asking,
  language: Language,
  row: AmountsAdmin,
  doc: AmountsDoc | undefined,
  run: Readonly<{ catalog: Catalog<AmountsAdmin>; done: () => void }>,
): AmountsAsk | null {
  if (asking === "revert") {
    return revertAsk(language, () => void run.catalog.revert("").then(run.done));
  }
  if (asking === "save" && doc !== undefined) {
    return saveAsk(language, row, doc, () => void run.catalog.save("", doc).then(run.done));
  }
  return null;
}

/** The one confirmation of a change to the amounts, before anything is paid at the new amounts. */
function AmountsConfirm({
  language,
  ask,
  busy,
  onCancel,
}: Readonly<{ language: Language; ask: AmountsAsk; busy: boolean; onCancel: () => void }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="warning" as="div" role="alert">
      <Stack>
        <strong>{ask.title}</strong>
        {ask.lines.map((line) => (
          <p key={line.key}>{line.text}</p>
        ))}
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={ask.apply}>
            {ask.applyLabel}
          </Button>
        </Toolbar>
      </Stack>
    </Notice>
  );
}

function AmountsEditor({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<AmountsAdmin>; row: AmountsAdmin }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<AmountsDraft>(() => amountsDraftOf(row));
  const [asking, setAsking] = useState<Asking>(null);
  const checked = checkAmounts(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const dirty = checked.ok && amountChanges(row, checked.doc).length > 0;
  const ask = askFor(asking, language, row, checked.ok ? checked.doc : undefined, {
    catalog,
    done: () => setAsking(null),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setAsking(dirty ? "save" : null);
      }}
    >
      <Stack>
        <div className={styles.head}>
          <span className={styles.name}>
            {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
          </span>
          <IconButton
            icon="undo"
            label={t("console.catalog.revert", { name: t("console.catalog.tab.amounts") })}
            disabled={catalog.busy || !row.revertible}
            onClick={() => setAsking("revert")}
          />
        </div>
        <ul className={styles.cards}>
          {(["xp", "gems"] as const).map((group) => (
            <AmountCard
              key={group}
              language={language}
              group={group}
              draft={draft}
              wrong={wrong}
              busy={catalog.busy}
              onChange={setDraft}
            />
          ))}
        </ul>
        {ask === null ? null : (
          <AmountsConfirm
            language={language}
            ask={ask}
            busy={catalog.busy}
            onCancel={() => setAsking(null)}
          />
        )}
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={dirty && asking === null}
          onDiscard={() => {
            setAsking(null);
            setDraft(amountsDraftOf(row));
          }}
        />
      </Stack>
    </form>
  );
}

/**
 * The amounts (T-709c, FR-1403, ADR-438): two equal cards, XP and gems, each amount a number field in its range. A save
 * asks once, naming each changed amount; it applies from the save on, including levels and tiers not yet paid.
 */
export function CatalogAmounts({ language }: Readonly<{ language: Language }>) {
  const catalog = useCatalog(language, AMOUNTS_API, readAmounts);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(row) => (
          <AmountsEditor
            key={JSON.stringify([row.xp, row.gems])}
            language={language}
            catalog={catalog}
            row={row}
          />
        )}
      </CatalogState>
    </Stack>
  );
}
