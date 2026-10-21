"use client";

import {
  QUEST_TYPES,
  formatEventTime,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { moved, textFor, type CategoryView, type QuestView } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/** What the builder asks the person to confirm before it deletes. */
export type Deleting =
  | Readonly<{ kind: "quest"; quest: QuestView }>
  | Readonly<{ kind: "category"; category: CategoryView }>;

export type CardActions = Readonly<{
  /** Where a quest's printed code is, for the types that have one. */
  codeLink: (quest: QuestView) => string | undefined;
  reorderCategories: (ids: string[]) => void;
  rename: (category: CategoryView, name: { ar: string; en: string }) => void;
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
  const t = translatorFor(language);
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
  const t = translatorFor(language);
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
  const t = translatorFor(language);
  const when = (iso: string | null, key: "quests.opens" | "quests.closes") =>
    iso === null ? null : (
      <span className={styles.muted}>
        {t(key, { time: formatEventTime(new Date(iso), timeZone, language) })}
      </span>
    );
  return (
    <li className={styles.card}>
      <strong>{textFor(quest.title, language)}</strong>
      <span className={styles.badge}>{t(QUEST_TYPES[quest.type].label)}</span>
      {quest.visible ? null : <span className={styles.badge}>{t("quests.hidden")}</span>}
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
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => actions.toggle(quest)}
          >
            {quest.visible ? t("quests.hide") : t("quests.show")}
          </button>
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

/** One category: its name and order, and its quests in order (FR-1004, FR-229). */
export function CategoryCard({
  language,
  timeZone,
  terms,
  category,
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
  const t = translatorFor(language);
  const [renaming, setRenaming] = useState(false);
  const questIds = category.quests.map((quest) => quest.id);
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    actions.rename(category, {
      ar: String(form.get("ar") ?? ""),
      en: String(form.get("en") ?? ""),
    });
    setRenaming(false);
  };
  return (
    <section className={styles.panel} aria-label={textFor(category.name, language)}>
      {renaming ? (
        <form className={styles.form} onSubmit={rename}>
          <CategoryNameFields language={language} initial={category} busy={busy} />
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
                {t("quests.renameCategory")}
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
  const t = translatorFor(language);
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
  const t = translatorFor(language);
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
