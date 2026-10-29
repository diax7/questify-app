"use client";

import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, FieldGroup, Input } from "#src/ui/Field.tsx";

export type Config = Readonly<Record<string, unknown>>;

/** What every quest type's fields take: the config so far and how to change it. */
export type TypeFieldProps = Readonly<{
  language: Language;
  config: Config;
  disabled: boolean;
  change: (config: Config) => void;
  /** A live poll already sent (T-306): its live setting, choices and minutes stay as they are. */
  sent?: boolean | undefined;
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
        <Field key={key} label={labels[key]}>
          <Input
            dir={key === "ar" ? "rtl" : "ltr"}
            maxLength={max}
            value={str(text[key])}
            disabled={disabled}
            onChange={(event) => change(withText(text, key, event.target.value))}
          />
        </Field>
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
        <FieldGroup key={item.id}>
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
            <Button
              variant="quiet"

              disabled={disabled}
              onClick={() => change(items.filter((one) => one.id !== item.id))}
            >
              {t("quests.vote.removeOption", { number: index + 1 })}
            </Button>
          ) : null}
        </FieldGroup>
      ))}
      {items.length < most ? (
        <Button
          variant="quiet"

          disabled={disabled}
          onClick={() => change([...items, newItem()])}
        >
          {t("quests.vote.addOption")}
        </Button>
      ) : null}
    </>
  );
}
