"use client";

import { QUEST_TYPES, QUEST_TYPE_NAMES, zoneLabel, type Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { QUEST_TYPE_FIELDS } from "#src/components/QuestTypeFields.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { textFor, type CategoryView, type QuestDraft } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  /** The event's zone: the times are typed and shown in it. */
  timeZone: string;
  categories: readonly CategoryView[];
  initial: QuestDraft;
  /** False when editing: a quest's type is fixed once it exists. */
  isNew: boolean;
  busy: boolean;
  save: (draft: QuestDraft) => void;
  cancel: () => void;
}>;

/** One quest's fields: the common ones, then its type's own (FR-1005, FR-1008, FR-225–227). */
export function QuestForm({
  language,
  timeZone,
  categories,
  initial,
  isNew,
  busy,
  save,
  cancel,
}: Props) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<QuestDraft>(initial);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const change = (patch: Partial<QuestDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const TypeFields = QUEST_TYPE_FIELDS[draft.type];
  const text = (
    key: "titleAr" | "titleEn" | "descriptionAr" | "descriptionEn",
    max: number,
    long = false,
  ) => {
    const props = {
      className: styles.input,
      dir: key.endsWith("Ar") ? "rtl" : "ltr",
      maxLength: max,
      value: draft[key],
      disabled: busy,
    } as const;
    return (
      <label className={styles.field}>
        {t(`quests.field.${key}`)}
        {long ? (
          <textarea
            {...props}
            rows={3}
            onChange={(event) => change({ [key]: event.target.value })}
          />
        ) : (
          <input {...props} onChange={(event) => change({ [key]: event.target.value })} />
        )}
      </label>
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save(draft);
  };
  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby="quest-form-title">
      <h2 id="quest-form-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {isNew ? t("quests.formNew") : t("quests.formEdit")}
      </h2>
      <label className={styles.field}>
        {t("quests.field.type")}
        <select
          className={styles.input}
          value={draft.type}
          disabled={busy || !isNew}
          onChange={(event) =>
            change({ type: event.target.value as QuestDraft["type"], config: {} })
          }
        >
          {QUEST_TYPE_NAMES.map((type) => (
            <option key={type} value={type}>
              {t(QUEST_TYPES[type].label)}
            </option>
          ))}
        </select>
      </label>
      {isNew ? null : <p className={styles.muted}>{t("quests.field.typeFixed")}</p>}
      <label className={styles.field}>
        {t("quests.field.category")}
        <select
          className={styles.input}
          value={draft.categoryId}
          disabled={busy}
          onChange={(event) => change({ categoryId: event.target.value })}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {textFor(category.name, language)}
            </option>
          ))}
        </select>
      </label>
      {text("titleAr", 120)}
      {text("titleEn", 120)}
      {text("descriptionAr", 2000, true)}
      {text("descriptionEn", 2000, true)}
      <label className={styles.field}>
        {t("quests.field.points")}
        <input
          className={styles.input}
          type="number"
          dir="ltr"
          min={0}
          max={100000}
          required
          value={draft.points}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value !== "") {
              change({ points: Number(event.target.value) });
            }
          }}
        />
      </label>
      <QuestRepeatField language={language} draft={draft} busy={busy} change={change} />
      {(["opensAt", "closesAt"] as const).map((key) => (
        <label key={key} className={styles.field}>
          {t(`quests.field.${key}`)}
          <input
            className={styles.input}
            type="datetime-local"
            dir="ltr"
            value={draft[key]}
            disabled={busy}
            onChange={(event) => change({ [key]: event.target.value })}
          />
        </label>
      ))}
      <p className={styles.muted}>
        {t("quests.field.windowHint", { zone: zoneLabel(timeZone, language) })}
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.visible}
          disabled={busy}
          onChange={(event) => change({ visible: event.target.checked })}
        />
        <span>{t("quests.field.visible")}</span>
      </label>
      <TypeFields
        language={language}
        config={draft.config}
        disabled={busy}
        change={(config) => change({ config })}
      />
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {isNew ? t("quests.create") : t("quests.save")}
        </button>
      </div>
    </form>
  );
}

/** "Can be done more than once", and how many times when it can (FR-227). */
function QuestRepeatField({
  language,
  draft,
  busy,
  change,
}: Readonly<{
  language: Language;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>) {
  const t = translatorFor(language);
  return (
    <>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.repeatCap > 1}
          disabled={busy}
          onChange={(event) => change({ repeatCap: event.target.checked ? 2 : 1 })}
        />
        <span>{t("quests.field.repeatable")}</span>
      </label>
      {draft.repeatCap > 1 ? (
        <label className={styles.field}>
          {t("quests.field.repeatCap")}
          <input
            className={styles.input}
            type="number"
            dir="ltr"
            min={2}
            max={100}
            required
            value={draft.repeatCap}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value !== "") {
                change({ repeatCap: Number(event.target.value) });
              }
            }}
          />
        </label>
      ) : null}
    </>
  );
}
