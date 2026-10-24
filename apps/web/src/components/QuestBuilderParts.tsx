"use client";

import {
  QUEST_TYPES,
  formatEventTime,
  isLivePoll,
  formatNumber,
  termFor,
  toLocalInput,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FlashControls, type FlashActions } from "#src/components/FlashControls.tsx";
import { PollControls, type PollActions } from "#src/components/PollControls.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import type { QuestItem } from "#src/lib/quest-items.ts";
import {
  categoryBody,
  categoryRuleNotes,
  moved,
  textFor,
  type CategoryRuleNote,
  type CategoryView,
  type QuestView,
} from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/** How the picker holds its choice: in the form's state (the quest form), or as a named field (the category form). */
type PickerBinding =
  | Readonly<{ value: string; change: (itemId: string) => void }>
  | Readonly<{ name: string; initial: string }>;

/**
 * The item a quest or category gives (T-304d, FR-522): none, or one of the event's quest items, with the stock left;
 * the items themselves are managed on the Prizes page.
 */
export function ItemPicker({
  language,
  items,
  hint,
  busy,
  ...binding
}: Readonly<{
  language: Language;
  items: readonly QuestItem[];
  hint: MessageKey;
  busy: boolean;
}> &
  PickerBinding) {
  const t = useTranslator(language);
  const hintId = useId();
  const bound =
    "change" in binding
      ? {
          value: binding.value,
          onChange: (e: { target: { value: string } }) => binding.change(e.target.value),
        }
      : { name: binding.name, defaultValue: binding.initial };
  return (
    <>
      <label className={styles.field}>
        {t("questItems.picker")}
        <select className={styles.input} aria-describedby={hintId} disabled={busy} {...bound}>
          <option value="">{t("questItems.pickerNone")}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {`${textFor(item.name, language)} (${t("questItems.left", {
                left: formatNumber(item.stockLeft, language),
                total: formatNumber(item.stockTotal, language),
              })})`}
            </option>
          ))}
        </select>
      </label>
      <p id={hintId} className={styles.muted}>
        {t(hint)}
      </p>
    </>
  );
}

/** What the builder asks the person to confirm before it deletes. */
export type Deleting =
  | Readonly<{ kind: "quest"; quest: QuestView }>
  | Readonly<{ kind: "category"; category: CategoryView }>;

export type CardActions = PollActions &
  FlashActions &
  Readonly<{
    /** Where a quest's printed code is, for the types that have one. */
    codeLink: (quest: QuestView) => string | undefined;
    reorderCategories: (ids: string[]) => void;
    /** Saves a category's names and rules (T-304). */
    saveCategory: (category: CategoryView, body: Record<string, unknown>) => void;
    reorderQuests: (category: CategoryView, ids: string[]) => void;
    toggle: (quest: QuestView) => void;
    pin: (quest: QuestView) => void;
    edit: (quest: QuestView) => void;
    add: (category: CategoryView) => void;
    remove: (target: Deleting) => void;
  }>;

/**
 * A heading that takes the focus when it appears, which also scrolls it into view: a dialog or form opened from far
 * down the page is seen at once, and a screen reader announces it.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** Asks before a change reaches players of a live event (FR-1007), then sends it again with the confirmation. */
export function LiveDialog({
  language,
  busy,
  cancel,
  confirm,
}: Readonly<{ language: Language; busy: boolean; cancel: () => void; confirm: () => void }>) {
  const t = useTranslator(language);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div role="alertdialog" aria-labelledby="live-title" className={styles.card}>
      <h2 id="live-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {t("quests.liveTitle")}
      </h2>
      <p>{t("quests.liveBody")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={confirm}>
          {t("common.continue")}
        </button>
      </div>
    </div>
  );
}

/** Up and Down for a row: keyboard and screen-reader friendly, no dragging, nothing to flip for right-to-left. */
function OrderButtons({
  language,
  name,
  ids,
  index,
  busy,
  apply,
}: Readonly<{
  language: Language;
  /** What moves, so each button says which row it moves. */
  name: string;
  ids: readonly string[];
  index: number;
  busy: boolean;
  apply: (ids: string[]) => void;
}>) {
  const t = useTranslator(language);
  const up = moved(ids, index, -1);
  const down = moved(ids, index, 1);
  return (
    <>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy || up === undefined}
        aria-label={t("quests.upNamed", { name })}
        onClick={() => up && apply(up)}
      >
        {t("quests.up")}
      </button>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy || down === undefined}
        aria-label={t("quests.downNamed", { name })}
        onClick={() => down && apply(down)}
      >
        {t("quests.down")}
      </button>
    </>
  );
}

function QuestRow({
  language,
  timeZone,
  terms,
  quest,
  ids,
  index,
  busy,
  actions,
  category,
  pinned,
  readOnly,
}: Readonly<{
  language: Language;
  timeZone: string;
  terms: EventTerms;
  quest: QuestView;
  ids: readonly string[];
  index: number;
  busy: boolean;
  actions: CardActions;
  category: CategoryView;
  /** The event's Up next pin (FR-1748). */
  pinned: boolean;
  readOnly: boolean;
}>) {
  const t = useTranslator(language);
  const live = isLivePoll(quest.type, quest.config);
  const when = (iso: string | null, key: "quests.opens" | "quests.closes") =>
    iso === null || live ? null : (
      <span className={styles.muted}>
        {t(key, { time: formatEventTime(new Date(iso), timeZone, language) })}
      </span>
    );
  return (
    <li className={live || quest.flash === true ? `${styles.card} ${styles.wrap}` : styles.card}>
      <strong>{textFor(quest.title, language)}</strong>
      <span className={styles.badge}>{t(QUEST_TYPES[quest.type].label)}</span>
      {quest.visible || live ? null : <span className={styles.badge}>{t("quests.hidden")}</span>}
      <PollControls
        language={language}
        timeZone={timeZone}
        quest={quest}
        busy={busy}
        readOnly={readOnly}
        actions={actions}
      />
      <FlashControls
        language={language}
        timeZone={timeZone}
        quest={quest}
        busy={busy}
        readOnly={readOnly}
        actions={actions}
      />
      {pinned ? <span className={styles.badge}>{t("quests.pinned")}</span> : null}
      {pinned && !quest.visible ? (
        <span className={styles.muted}>{t("quests.pinnedHidden")}</span>
      ) : null}
      <span className={styles.muted}>
        {t("quests.pointsShort", {
          currency: termFor(terms.currency, language),
          points: quest.points,
        })}
      </span>
      {quest.repeatCap > 1 ? (
        <span className={styles.muted}>
          {t("quests.repeatShort", { player: terms.player[language].one, count: quest.repeatCap })}
        </span>
      ) : null}
      {(quest.firstBonus ?? null) === null ? null : (
        <span className={styles.badge}>
          {t("builder.firstBonus.listLeft", {
            slots: formatNumber(quest.firstBonus?.slots ?? 0, language),
            left: formatNumber(quest.firstBonus?.left ?? 0, language),
          })}
        </span>
      )}
      {when(quest.opensAt, "quests.opens")}
      {when(quest.closesAt, "quests.closes")}
      {readOnly ? null : (
        <div className={styles.actions}>
          <OrderButtons
            language={language}
            name={textFor(quest.title, language)}
            ids={ids}
            index={index}
            busy={busy}
            apply={(order) => actions.reorderQuests(category, order)}
          />
          {live ? null : (
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => actions.toggle(quest)}
            >
              {quest.visible ? t("quests.hide") : t("quests.show")}
            </button>
          )}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            aria-pressed={pinned}
            onClick={() => actions.pin(quest)}
          >
            {t("quests.pin")}
          </button>
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => actions.edit(quest)}
          >
            {t("quests.edit")}
          </button>
          {actions.codeLink(quest) === undefined ? null : (
            <a className={styles.textLink} href={actions.codeLink(quest)}>
              {t("codes.printQr")}
            </a>
          )}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => actions.remove({ kind: "quest", quest })}
          >
            {t("quests.delete")}
          </button>
        </div>
      )}
    </li>
  );
}

/** A rule note in words, for the category card. */
function ruleText(
  note: CategoryRuleNote,
  t: Translate,
  language: Language,
  timeZone: string,
): string {
  switch (note.kind) {
    case "inOrder":
      return t("quests.category.inOrder");
    case "opens":
      return t("quests.category.opens", {
        time: formatEventTime(new Date(note.at), timeZone, language),
      });
    case "unlockAfter":
      return t("quests.category.unlockAfter", { name: textFor(note.name, language) });
    case "bonus":
      return t("quests.category.bonus", { points: formatNumber(note.points, language) });
    case "resets":
      return t(
        note.refresh === "daily" ? "quests.category.resetsDaily" : "quests.category.resetsWeekly",
      );
    case "hidden":
      return t("quests.category.hidden");
  }
}

/**
 * A category's rules as form fields (T-304): its order, its opening time, its unlock and its completion bonus; its
 * refresh and whether it is hidden until found (T-304c).
 */
function CategoryRuleFields({
  language,
  timeZone,
  category,
  categories,
  items,
  busy,
}: Readonly<{
  language: Language;
  timeZone: string;
  category: CategoryView;
  categories: readonly CategoryView[];
  items: readonly QuestItem[];
  busy: boolean;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <label className={styles.field}>
        {t("quests.field.orderMode")}
        <select
          className={styles.input}
          name="orderMode"
          defaultValue={category.orderMode}
          disabled={busy}
        >
          <option value="any">{t("quests.field.orderAny")}</option>
          <option value="in_order">{t("quests.field.orderInOrder")}</option>
        </select>
      </label>
      <label className={styles.field}>
        {t("quests.field.categoryOpensAt")}
        <input
          className={styles.input}
          type="datetime-local"
          name="opensAt"
          dir="ltr"
          defaultValue={
            category.opensAt === null ? "" : toLocalInput(new Date(category.opensAt), timeZone)
          }
          disabled={busy}
        />
      </label>
      <label className={styles.field}>
        {t("quests.field.unlockAfter")}
        <select
          className={styles.input}
          name="unlockAfter"
          defaultValue={category.unlockAfter ?? ""}
          disabled={busy}
        >
          <option value="">{t("quests.field.unlockNone")}</option>
          {categories
            .filter((other) => other.id !== category.id)
            .map((other) => (
              <option key={other.id} value={other.id}>
                {textFor(other.name, language)}
              </option>
            ))}
        </select>
      </label>
      <label className={styles.field}>
        {t("quests.field.completionBonus")}
        <input
          className={styles.input}
          type="number"
          name="completionBonus"
          dir="ltr"
          min={0}
          max={100_000}
          step={1}
          defaultValue={category.completionBonus}
          disabled={busy}
        />
      </label>
      <ItemPicker
        language={language}
        items={items}
        hint="questItems.pickerCategory"
        busy={busy}
        name="itemId"
        initial={category.itemId ?? ""}
      />
      <p className={styles.muted}>{t("quests.field.rulesHint")}</p>
      <label className={styles.field}>
        {t("quests.field.refresh")}
        <select
          className={styles.input}
          name="refresh"
          defaultValue={category.refresh}
          aria-describedby={`refresh-hint-${category.id}`}
          disabled={busy}
        >
          <option value="none">{t("quests.field.refreshNone")}</option>
          <option value="daily">{t("quests.field.refreshDaily")}</option>
          <option value="weekly">{t("quests.field.refreshWeekly")}</option>
        </select>
      </label>
      <p id={`refresh-hint-${category.id}`} className={styles.muted}>
        {t("quests.field.refreshHint")}
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          name="hidden"
          defaultChecked={category.hidden}
          aria-describedby={`hidden-hint-${category.id}`}
          disabled={busy}
        />
        <span>{t("quests.field.hidden")}</span>
      </label>
      <p id={`hidden-hint-${category.id}`} className={styles.muted}>
        {t("quests.field.hiddenHint")}
      </p>
    </>
  );
}

/** One category: its name, rules and order, and its quests in order (FR-1004, FR-229, T-304). */
export function CategoryCard({
  language,
  timeZone,
  terms,
  category,
  categories,
  items,
  order,
  index,
  busy,
  actions,
  focusQuestId,
  readOnly,
  canDelete,
}: Readonly<{
  language: Language;
  timeZone: string;
  terms: EventTerms;
  category: CategoryView;
  /** Every category of the event, for the unlock choice and its name. */
  categories: readonly CategoryView[];
  /** The event's quest items, for the item picker (T-304d). */
  items: readonly QuestItem[];
  order: readonly string[];
  index: number;
  busy: boolean;
  actions: CardActions;
  focusQuestId: string | null;
  /** An ended event: everything is shown, nothing changes. */
  readOnly: boolean;
  /** False for the last category: every event keeps one (FR-228). */
  canDelete: boolean;
}>) {
  const t = useTranslator(language);
  const [renaming, setRenaming] = useState(false);
  const questIds = category.quests.map((quest) => quest.id);
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    actions.saveCategory(category, categoryBody(new FormData(event.currentTarget)));
    setRenaming(false);
  };
  const notes = categoryRuleNotes(category, categories).map((note) =>
    ruleText(note, t, language, timeZone),
  );
  return (
    <section className={styles.panel} aria-label={textFor(category.name, language)}>
      {renaming ? (
        <form className={styles.form} onSubmit={save}>
          <CategoryNameFields language={language} initial={category} busy={busy} />
          <CategoryRuleFields
            language={language}
            timeZone={timeZone}
            category={category}
            categories={categories}
            items={items}
            busy={busy}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.quiet} onClick={() => setRenaming(false)}>
              {t("common.cancel")}
            </button>
            <button type="submit" className={styles.button} disabled={busy}>
              {t("quests.saveCategory")}
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.row}>
          <h2 className={styles.subtitle}>{textFor(category.name, language)}</h2>
          {readOnly ? null : (
            <div className={styles.actions}>
              <OrderButtons
                language={language}
                name={textFor(category.name, language)}
                ids={order}
                index={index}
                busy={busy}
                apply={actions.reorderCategories}
              />
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                onClick={() => setRenaming(true)}
              >
                {t("quests.editCategory")}
              </button>
              {canDelete ? (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy}
                  onClick={() => actions.remove({ kind: "category", category })}
                >
                  {t("quests.deleteCategory")}
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
      {renaming || notes.length === 0 ? null : <p className={styles.muted}>{notes.join(" · ")}</p>}
      {category.quests.length === 0 ? (
        <p className={styles.muted}>{t("quests.noQuests")}</p>
      ) : (
        <ul className={styles.list}>
          {category.quests.map((quest, questIndex) => (
            <QuestRow
              key={quest.id}
              language={language}
              timeZone={timeZone}
              terms={terms}
              quest={quest}
              ids={questIds}
              index={questIndex}
              busy={busy}
              actions={actions}
              category={category}
              pinned={quest.id === focusQuestId}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
      {readOnly ? null : (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => actions.add(category)}
        >
          {t("quests.addQuest")}
        </button>
      )}
    </section>
  );
}

/** A category's two names, as form fields named `ar` and `en`. */
export function CategoryNameFields({
  language,
  initial,
  busy,
}: Readonly<{ language: Language; initial?: CategoryView | undefined; busy: boolean }>) {
  const t = useTranslator(language);
  return (
    <>
      <label className={styles.field}>
        {t("quests.field.categoryAr")}
        <input
          className={styles.input}
          name="ar"
          dir="rtl"
          maxLength={120}
          defaultValue={initial?.name.ar ?? ""}
          disabled={busy}
        />
      </label>
      <label className={styles.field}>
        {t("quests.field.categoryEn")}
        <input
          className={styles.input}
          name="en"
          dir="ltr"
          maxLength={120}
          defaultValue={initial?.name.en ?? ""}
          disabled={busy}
        />
      </label>
    </>
  );
}

/**
 * The confirmation before a delete, naming what goes. A category that holds quests asks what happens to them: move
 * them to another category, or delete them with it (FR-1004).
 */
export function DeleteDialog({
  language,
  target,
  categories,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  target: Deleting;
  categories: readonly CategoryView[];
  busy: boolean;
  cancel: () => void;
  confirm: (choice: Readonly<Record<string, unknown>>) => void;
}>) {
  const t = useTranslator(language);
  const others =
    target.kind === "category" ? categories.filter((item) => item.id !== target.category.id) : [];
  // No choice is made for the person: the button waits until they pick one (the UX confirmation pattern).
  const [choice, setChoice] = useState<string | null>(null);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const holds = target.kind === "category" ? target.category.quests.length : 0;
  const name =
    target.kind === "quest"
      ? textFor(target.quest.title, language)
      : textFor(target.category.name, language);
  const go = () =>
    confirm(
      holds === 0
        ? {}
        : choice === "delete"
          ? { quests: "delete" }
          : { quests: "move", to: choice },
    );
  return (
    <div role="alertdialog" aria-labelledby="delete-title" className={styles.card}>
      <h2 id="delete-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {t(target.kind === "quest" ? "quests.deleteTitle" : "quests.deleteCategoryTitle")}
      </h2>
      {holds === 0 ? (
        <p>
          {t(target.kind === "quest" ? "quests.deleteBody" : "quests.deleteCategoryBody", { name })}
        </p>
      ) : (
        <fieldset className={styles.choices}>
          <legend>{t("quests.deleteCategoryHolds", { name, count: holds })}</legend>
          {others.map((other) => (
            <label key={other.id} className={styles.check}>
              <input
                type="radio"
                name="fate"
                checked={choice === other.id}
                onChange={() => setChoice(other.id)}
              />
              <span>
                {t("quests.moveTo")} {textFor(other.name, language)}
              </span>
            </label>
          ))}
          <label className={styles.check}>
            <input
              type="radio"
              name="fate"
              checked={choice === "delete"}
              onChange={() => setChoice("delete")}
            />
            <span>{t("quests.deleteThem")}</span>
          </label>
        </fieldset>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy || (holds > 0 && choice === null)}
          onClick={go}
        >
          {t(target.kind === "quest" ? "quests.delete" : "quests.deleteCategory")}
        </button>
      </div>
    </div>
  );
}
