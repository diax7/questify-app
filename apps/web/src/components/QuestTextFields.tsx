"use client";

import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

export type Config = Readonly<Record<string, unknown>>;

/** What every quest type's fields take: the config so far and how to change it. */
export type TypeFieldProps = Readonly<{
  language: Language;
  config: Config;
  disabled: boolean;
  change: (config: Config) => void;
}>;

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

export type Text = Readonly<{ ar?: string; en?: string }>;
export type Item = Readonly<{ id: string; text: Text }>;

export const newId = () => crypto.randomUUID();
export const newItem = (): Item => ({ id: newId(), text: {} });
export const itemsOf = (value: unknown, least: number): readonly Item[] =>
  Array.isArray(value) ? (value as Item[]) : Array.from({ length: least }, newItem);
/** A text with an emptied language left out, as the API wants it (at least one language, FR-1008). */
export const withText = (text: Text, key: "ar" | "en", value: string): Text => {
  const next: Record<string, string> = {};
  for (const name of ["ar", "en"] as const) {
    const kept = name === key ? value : text[name];
    if (kept !== undefined && kept !== "") {
      next[name] = kept;
    }
  }
  return next;
};

/** Two inputs, Arabic and English, for one option, choice or question. */
export function TextPair({
  labels,
  text,
  max,
  disabled,
  change,
}: Readonly<{
  labels: Readonly<{ ar: string; en: string }>;
  text: Text;
  max: number;
  disabled: boolean;
  change: (text: Text) => void;
}>) {
  return (
    <>
      {(["ar", "en"] as const).map((key) => (
        <label key={key} className={styles.field}>
          {labels[key]}
          <input
            className={styles.input}
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={max}
            value={str(text[key])}
            disabled={disabled}
            onChange={(event) => change(withText(text, key, event.target.value))}
          />
        </label>
      ))}
    </>
  );
}

/** A list of options (a vote's, or one quiz question's choices): at least 2, each in both languages. */
export function OptionList({
  language,
  items,
  most,
  disabled,
  change,
}: Readonly<{
  language: Language;
  items: readonly Item[];
  most: number;
  disabled: boolean;
  change: (items: readonly Item[]) => void;
}>) {
  const t = translatorFor(language);
  const edit = (id: string, text: Text) =>
    change(items.map((one) => (one.id === id ? { ...one, text } : one)));
  return (
    <>
      {items.map((item, index) => (
        <div key={item.id} className={styles.field}>
          <TextPair
            labels={{
              ar: t("quests.choiceAr", { number: index + 1 }),
              en: t("quests.choiceEn", { number: index + 1 }),
            }}
            text={item.text}
            max={120}
            disabled={disabled}
            change={(text) => edit(item.id, text)}
          />
          {items.length > 2 ? (
            <button
              type="button"
              className={styles.quiet}
              disabled={disabled}
              onClick={() => change(items.filter((one) => one.id !== item.id))}
            >
              {t("quests.vote.removeOption", { number: index + 1 })}
            </button>
          ) : null}
        </div>
      ))}
      {items.length < most ? (
        <button
          type="button"
          className={styles.quiet}
          disabled={disabled}
          onClick={() => change([...items, newItem()])}
        >
          {t("quests.vote.addOption")}
        </button>
      ) : null}
    </>
  );
}
