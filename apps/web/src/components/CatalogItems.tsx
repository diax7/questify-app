"use client";

import { ITEM_KINDS, visualsOf, type ItemAdmin, type Language } from "@questify/shared";
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
import { Problem, keyed } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import {
  ITEMS_API,
  checkItem,
  checkNewItem,
  isItemDirty,
  itemDraftOf,
  newItemDraft,
  readItems,
  sourceOf,
  withKind,
  type ItemDraft,
  type NewItemDraft,
} from "#src/lib/console-catalog-xp.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Input, Select } from "#src/ui/Field.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { Stack } from "#src/ui/Section.tsx";

const KIND_ICON = { character: "users", frame: "layout", title: "award" } as const;
const ART_LOCK = {
  on_sale: "console.catalog.items.lock.onSale",
  owned: "console.catalog.items.lock.owned",
} as const;

/** The art picker of one kind: the shipped keys, or the item's only one. Off while the art is locked. */
function ArtPicker({
  language,
  kind,
  value,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  kind: ItemAdmin["kind"];
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Field label={t("console.catalog.items.art")}>
      <Select
        dir="ltr"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        {visualsOf(kind).map((key) => (
          <option key={key ?? "none"} value={key ?? ""}>
            {key ?? t("console.catalog.items.noArt")}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function ItemEditor({
  language,
  catalog,
  item,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<ItemAdmin[]>;
  item: ItemAdmin;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<ItemDraft>(() => itemDraftOf(item));
  const checked = checkItem(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          void catalog.save(item.id, checked.doc).then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        <PairInputs
          language={language}
          label={t("console.catalog.items.name")}
          field="name"
          value={draft.name}
          invalid={wrong}
          disabled={catalog.busy}
          onChange={(name) => setDraft({ ...draft, name })}
        />
        <ArtPicker
          language={language}
          kind={item.kind}
          value={draft.visualKey}
          disabled={catalog.busy || item.locked.art !== null}
          onChange={(visualKey) => setDraft({ ...draft, visualKey })}
        />
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && isItemDirty(item, draft)}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function SourceBadge({ language, item }: Readonly<{ language: Language; item: ItemAdmin }>) {
  const t = translatorFor(language);
  const source = sourceOf(item);
  if (source.kind === "level") {
    return (
      <Badge tone="info">{t("console.catalog.items.source.level", { level: source.level })}</Badge>
    );
  }
  return (
    <Badge tone={source.kind === "shop" ? "info" : "neutral"}>
      {t(`console.catalog.items.source.${source.kind}`)}
    </Badge>
  );
}

function ItemCard({
  language,
  catalog,
  item,
}: Readonly<{ language: Language; catalog: Catalog<ItemAdmin[]>; item: ItemAdmin }>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState(false);
  return (
    <li className={styles.card} data-testid="item-card" data-id={item.id} data-editing={editing}>
      <div className={styles.head}>
        <span className={styles.name}>
          <span className={styles.code} dir="ltr">
            {item.id}
          </span>
          <SourceBadge language={language} item={item} />
          {item.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={item.name[language]}
          busy={catalog.busy}
          open={editing}
          revertible={item.revertible}
          onEdit={() => setEditing(true)}
          onRevert={() => void catalog.revert(item.id)}
        />
      </div>
      {editing ? (
        <ItemEditor
          language={language}
          catalog={catalog}
          item={item}
          onDone={() => setEditing(false)}
        />
      ) : (
        <PairCells language={language} value={item.name} />
      )}
      <p className={styles.facts} data-testid="item-facts">
        <Icon name={KIND_ICON[item.kind]} /> {t(`console.catalog.shop.kind.${item.kind}`)} ·{" "}
        <span dir="ltr">{item.visualKey ?? t("console.catalog.items.noArt")}</span>
        {item.locked.art === null ? null : <> · {t(ART_LOCK[item.locked.art])}</>}
      </p>
    </li>
  );
}

function NewItemFields({
  language,
  draft,
  wrong,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  draft: NewItemDraft;
  wrong: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: NewItemDraft) => void;
}>) {
  const t = translatorFor(language);
  const invalid = (field: string) => (wrong.has(field) ? t("console.catalog.invalid") : undefined);
  const number = (field: "price" | "position", label: string) => (
    <Field label={label} error={invalid(`shop.${field}`)}>
      <Input
        inputMode="numeric"
        dir="ltr"
        value={draft[field]}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
      />
    </Field>
  );
  return (
    <>
      <div className={styles.fields}>
        <Field label={t("console.catalog.items.id")} error={invalid("id")}>
          <Input
            dir="ltr"
            value={draft.id}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, id: event.target.value })}
          />
        </Field>
        <Field label={t("console.catalog.items.kind")}>
          <Select
            value={draft.kind}
            disabled={disabled}
            onChange={(event) =>
              onChange(withKind(draft, event.target.value as NewItemDraft["kind"]))
            }
          >
            {ITEM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`console.catalog.shop.kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <ArtPicker
          language={language}
          kind={draft.kind}
          value={draft.visualKey}
          disabled={disabled}
          onChange={(visualKey) => onChange({ ...draft, visualKey })}
        />
      </div>
      <PairInputs
        language={language}
        label={t("console.catalog.items.name")}
        field="name"
        value={draft.name}
        invalid={wrong}
        disabled={disabled}
        onChange={(name) => onChange({ ...draft, name })}
      />
      <Checkbox
        label={t("console.catalog.items.onSale")}
        checked={draft.onSale}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, onSale: event.target.checked })}
      />
      {draft.onSale ? (
        <div className={styles.fields}>
          {number("price", t("console.catalog.shop.price"))}
          {number("position", t("console.catalog.shop.position"))}
        </div>
      ) : null}
    </>
  );
}

function NewItem({
  language,
  catalog,
  onDone,
}: Readonly<{ language: Language; catalog: Catalog<ItemAdmin[]>; onDone: () => void }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<NewItemDraft>(newItemDraft);
  const [problem, setProblem] = useState<string | null>(null);
  const checked = checkNewItem(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  return (
    <form
      className={styles.card}
      data-editing="true"
      data-testid="item-new"
      onSubmit={(event) => {
        event.preventDefault();
        if (!checked.ok) return;
        void requestJson("POST", ITEMS_API, checked.doc, keyed()).then((result) => {
          setProblem(
            result.ok ? null : describeProblem(result.body, language, translatorFor(language)).text,
          );
          if (result.ok) {
            void catalog.reload();
            onDone();
          }
        });
      }}
    >
      <Stack>
        <NewItemFields
          language={language}
          draft={draft}
          wrong={wrong}
          disabled={catalog.busy}
          onChange={setDraft}
        />
        <Problem problem={problem} />
        <div>
          <Button type="submit" disabled={catalog.busy || !checked.ok}>
            {t("console.catalog.items.create")}
          </Button>{" "}
          <Button variant="quiet" onClick={onDone}>
            {t("console.catalog.discard")}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * Questify's items (T-709d, FR-1403, ADR-441): equal cards with the kind, both names, the art and a source badge (the level
 * it rewards, the shop, or unassigned). Names can always change; the art picker is off, with the reason, once the item is
 * on sale or players own it. A new item is made here, optionally on sale. Organizers' souvenirs are never shown.
 */
export function CatalogItems({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, ITEMS_API, readItems);
  const [creating, setCreating] = useState(false);
  return (
    <Stack>
      <div>
        <Button variant="secondary" disabled={creating} onClick={() => setCreating(true)}>
          {t("console.catalog.items.new")}
        </Button>
      </div>
      {creating ? (
        <NewItem language={language} catalog={catalog} onDone={() => setCreating(false)} />
      ) : null}
      <CatalogState language={language} catalog={catalog}>
        {(items) => (
          <ul className={styles.cards}>
            {items.map((item) => (
              <ItemCard key={item.id} language={language} catalog={catalog} item={item} />
            ))}
          </ul>
        )}
      </CatalogState>
    </Stack>
  );
}
