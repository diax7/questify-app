"use client";

import type { GemShopItemAdmin, Language } from "@questify/shared";
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
  GEM_SHOP_API,
  checkShop,
  isShopDirty,
  readGemShop,
  shopDraftOf,
  type ShopDraft,
} from "#src/lib/console-catalog.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

function ShopEditor({
  language,
  catalog,
  row,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<GemShopItemAdmin[]>;
  row: GemShopItemAdmin;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<ShopDraft>(() => shopDraftOf(row));
  const checked = checkShop(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const number = (field: "price" | "position", label: string) => (
    <Field label={label} error={wrong.has(field) ? t("console.catalog.invalid") : undefined}>
      <Input
        inputMode="numeric"
        dir="ltr"
        value={draft[field]}
        disabled={catalog.busy}
        onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
      />
    </Field>
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          void catalog
            .save(row.itemId, checked.doc)
            .then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        <div className={styles.fields}>
          {number("price", t("console.catalog.shop.price"))}
          <Field label={t("console.catalog.shop.status")}>
            <Select
              value={draft.status}
              disabled={catalog.busy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  status: event.target.value === "retired" ? "retired" : "active",
                })
              }
            >
              <option value="active">{t("console.catalog.shop.status.active")}</option>
              <option value="retired">{t("console.catalog.shop.status.retired")}</option>
            </Select>
          </Field>
          {number("position", t("console.catalog.shop.position"))}
        </div>
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && isShopDirty(row, draft)}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function ShopCard({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<GemShopItemAdmin[]>; row: GemShopItemAdmin }>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState(false);
  return (
    <li className={styles.card} data-testid="shop-card" data-id={row.itemId} data-editing={editing}>
      <div className={styles.head}>
        <span className={styles.name}>
          <Badge>{t(`console.catalog.shop.kind.${row.kind}`)}</Badge>
          <Badge tone={row.status === "active" ? "success" : "neutral"}>
            {t(`console.catalog.shop.status.${row.status}`)}
          </Badge>
          {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={row.name[language]}
          busy={catalog.busy}
          open={editing}
          revertible={row.revertible}
          onEdit={() => setEditing(true)}
          onRevert={() => void catalog.revert(row.itemId)}
        />
      </div>
      <PairCells language={language} value={row.name} />
      {editing ? (
        <ShopEditor
          language={language}
          catalog={catalog}
          row={row}
          onDone={() => setEditing(false)}
        />
      ) : (
        <p className={styles.facts}>
          {t("console.catalog.shop.summary", { price: row.price, position: row.position })}
        </p>
      )}
    </li>
  );
}

/**
 * The gem shop (T-709b, FR-1403): each item's price, whether it is on sale and its place. Names, kinds and art are fixed
 * here; what players paid and what they own does not change.
 */
export function CatalogGemShop({ language }: Readonly<{ language: Language }>) {
  const catalog = useCatalog(language, GEM_SHOP_API, readGemShop);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <ul className={styles.cards}>
            {rows.map((row) => (
              <ShopCard key={row.itemId} language={language} catalog={catalog} row={row} />
            ))}
          </ul>
        )}
      </CatalogState>
    </Stack>
  );
}
