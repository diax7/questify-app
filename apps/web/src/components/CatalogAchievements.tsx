"use client";

import {
  formatNumber,
  type AchievementAdmin,
  type ItemAdmin,
  type Language,
  type LoweredTiers,
} from "@questify/shared";
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
  TIERS,
  achievementDraftOf,
  checkAchievement,
  isAchievementDirty,
  loweredTiersOf,
  readAchievements,
  unlockChoices,
  type AchievementDraft,
} from "#src/lib/console-catalog.ts";
import { ITEMS_API, readItems } from "#src/lib/console-catalog-xp.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { PostResult } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

/** A lowering the API refused until confirmed: what it pays, and the same call with the confirmation. */
type Ask = Readonly<{ tiers: LoweredTiers; again: () => Promise<boolean> }>;

type Items = readonly ItemAdmin[];

/** An item's name, or its id when the items could not be read (the picker still shows what the achievement holds). */
const itemName = (items: Items, id: string, language: Language): string =>
  items.find((item) => item.id === id)?.name[language] ?? id;

/**
 * The one confirmation of a lowering (ADR-437): one line per lowered tier with the XP it pays now and whether its item comes with it, and that undoing
 * does not take them back.
 */
function LowerConfirm({
  language,
  name,
  ask,
  busy,
  onClose,
}: Readonly<{ language: Language; name: string; ask: Ask; busy: boolean; onClose: () => void }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="warning" as="div" role="alert">
      <Stack>
        <strong>{t("console.catalog.lower.title", { name })}</strong>
        {TIERS.map((tier) => {
          const pays = ask.tiers[tier];
          return pays === undefined ? null : (
            <p key={tier}>
              {t("console.catalog.lower.line", {
                tier: t(`console.catalog.achievements.${tier}`),
                xp: formatNumber(pays.xp, language),
              })}
              {pays.itemId === null ? null : <> {t("console.catalog.lower.item")}</>}
            </p>
          );
        })}
        <p>{t("console.catalog.lower.undo")}</p>
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void ask.again().then((done) => (done ? onClose() : undefined))}
          >
            {t("console.catalog.lower.pay")}
          </Button>
        </Toolbar>
      </Stack>
    </Notice>
  );
}

/**
 * "Unlocks" (T-404d, ADR-765): the item this achievement gives and the tier that gives it, from the items nothing else
 * uses. The tier is chosen only with an item. The API refuses a move or removal once a player got the item from this
 * achievement, and says so in the page's language.
 */
function UnlockFields({
  language,
  achievementId,
  items,
  draft,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  achievementId: string;
  items: Items;
  draft: AchievementDraft;
  disabled: boolean;
  onChange: (next: AchievementDraft) => void;
}>) {
  const t = translatorFor(language);
  const choices = unlockChoices(items, achievementId);
  const known = draft.itemId === "" || choices.some((item) => item.id === draft.itemId);
  return (
    <div className={styles.fields}>
      <Field
        label={
          <>
            <Icon name="gift" /> {t("console.catalog.achievements.unlocks")}
          </>
        }
      >
        <Select
          data-testid="achievement-item"
          value={draft.itemId}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, itemId: event.target.value })}
        >
          <option value="">{t("console.catalog.achievements.noItem")}</option>
          {known ? null : (
            <option value={draft.itemId}>{itemName(items, draft.itemId, language)}</option>
          )}
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name[language]} · {t(`console.catalog.items.kind.${item.kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("console.catalog.achievements.unlocksTier")}>
        <Select
          data-testid="achievement-item-tier"
          value={draft.itemTier}
          disabled={disabled || draft.itemId === ""}
          onChange={(event) =>
            onChange({ ...draft, itemTier: event.target.value as AchievementDraft["itemTier"] })
          }
        >
          {TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {t(`console.catalog.achievements.${tier}`)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function AchievementEditor({
  language,
  catalog,
  row,
  items,
  onAsk,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<AchievementAdmin[]>;
  row: AchievementAdmin;
  items: Items;
  /** The refusal handler of a save of `doc`: a lowering opens the confirmation instead of a problem. */
  onAsk: (doc: object) => (result: PostResult) => boolean;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<AchievementDraft>(() => achievementDraftOf(row));
  const checked = checkAchievement(row, draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const save = (doc: object) =>
    catalog.save(row.id, doc, onAsk(doc)).then((saved) => (saved ? onDone() : undefined));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok) {
          void save(checked.doc);
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
              label={
                <>
                  <Icon name="award" /> {t(`console.catalog.achievements.${tier}`)}
                </>
              }
              error={
                wrong.has(tier) || wrong.has("thresholds")
                  ? t("console.catalog.invalid")
                  : undefined
              }
            >
              <Input
                type="number"
                inputMode="numeric"
                dir="ltr"
                min={1}
                max={100_000}
                step={1}
                value={draft[tier]}
                disabled={catalog.busy}
                data-tier={tier}
                onChange={(event) => setDraft({ ...draft, [tier]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        <UnlockFields
          language={language}
          achievementId={row.id}
          items={items}
          draft={draft}
          disabled={catalog.busy}
          onChange={setDraft}
        />
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
  items,
}: Readonly<{
  language: Language;
  catalog: Catalog<AchievementAdmin[]>;
  row: AchievementAdmin;
  /** Null while the items are being read: the card then shows no "Unlocks" line rather than an id. */
  items: Items | null;
}>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  /** A refusal that asks for the confirmation opens it, with `again` as the confirmed call. */
  const asking =
    (again: () => Promise<boolean>) =>
    (result: PostResult): boolean => {
      const tiers = loweredTiersOf(result.body);
      if (tiers === undefined) {
        return false;
      }
      setAsk({ tiers, again });
      return true;
    };
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
          onRevert={() =>
            void catalog.revert(
              row.id,
              {},
              asking(() => catalog.revert(row.id, { confirmed: true })),
            )
          }
        />
      </div>
      {editing ? (
        <AchievementEditor
          language={language}
          catalog={catalog}
          row={row}
          items={items ?? []}
          onAsk={(doc) =>
            asking(() =>
              catalog.save(row.id, { ...doc, confirmed: true }).then((saved) => {
                if (saved) setEditing(false);
                return saved;
              }),
            )
          }
          onDone={() => setEditing(false)}
        />
      ) : (
        <PairCells language={language} value={row.name} />
      )}
      {ask === null ? null : (
        <LowerConfirm
          language={language}
          name={row.name[language]}
          ask={ask}
          busy={catalog.busy}
          onClose={() => setAsk(null)}
        />
      )}
      <p className={styles.facts} dir="ltr" data-testid="achievement-tiers">
        {TIERS.map((tier) => `${t(`console.catalog.achievements.${tier}`)} ${row[tier]}`).join(
          " · ",
        )}
      </p>
      {row.item === null || items === null ? null : (
        <p className={styles.facts} dir="auto" data-testid="achievement-unlocks">
          <Icon name="gift" /> {t("console.catalog.achievements.unlocks")}:{" "}
          {itemName(items, row.item.itemId, language)} (
          {t(`console.catalog.achievements.${row.item.tier}`)})
        </p>
      )}
    </li>
  );
}

/**
 * The achievements (T-709b, T-709c, FR-1403): five equal cards with the name in both languages and the three tier
 * thresholds. A lower threshold pays XP and the tier's item at every player's next sync and a revert cannot take them back, so a
 * save or a revert that lowers one asks once, naming them (ADR-437).
 */
export function CatalogAchievements({ language }: Readonly<{ language: Language }>) {
  const own = useCatalog(language, ACHIEVEMENTS_API, readAchievements);
  const itemsRead = useConsoleRead(ITEMS_API, readItems);
  const items: Items | null =
    itemsRead.state.kind === "loading"
      ? null
      : itemsRead.state.kind === "ready"
        ? itemsRead.state.value
        : [];
  // A save or a revert can move an item's source, so the items are read again after each one the API accepted.
  const catalog: Catalog<AchievementAdmin[]> = {
    ...own,
    save: async (id, doc, handled) => {
      const saved = await own.save(id, doc, handled);
      if (saved) await itemsRead.reload();
      return saved;
    },
    revert: async (id, body, handled) => {
      const reverted = await own.revert(id, body, handled);
      if (reverted) await itemsRead.reload();
      return reverted;
    },
  };
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <ul className={styles.cards}>
            {rows.map((row) => (
              <AchievementCard
                key={row.id}
                language={language}
                catalog={catalog}
                row={row}
                items={items}
              />
            ))}
          </ul>
        )}
      </CatalogState>
    </Stack>
  );
}
