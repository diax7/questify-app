"use client";

import {
  LINK_URL_MAX,
  type Language,
  type LocalText,
  type MessageKey,
  type TapAction,
} from "@questify/shared";
import type { ChangeEvent } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Field, FieldGroup, Input, Select, Textarea } from "#src/ui/Field.tsx";

/** What the quest and reward pickers offer: an id and the name the organizer knows it by. */
export type PickOption = Readonly<{ id: string; label: string }>;

export type EditorContext = Readonly<{
  language: Language;
  quests: readonly PickOption[];
  rewards: readonly PickOption[];
  /** The event's time zone, in which a countdown's moment is typed. */
  zone: string;
}>;

type TextField = Extract<
  MessageKey,
  | "layout.field.title"
  | "layout.field.subtitle"
  | "layout.field.body"
  | "layout.field.label"
  | "layout.field.message"
>;

/** The Arabic and English boxes of one text, side by side when there is room. */
export function TextPair({
  language,
  field,
  value,
  max,
  multiline = false,
  onChange,
}: Readonly<{
  language: Language;
  field: TextField;
  value: LocalText;
  max: number;
  multiline?: boolean;
  onChange: (next: LocalText) => void;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      {(["ar", "en"] as const).map((lang) => {
        const props = {
          value: value[lang],
          maxLength: max,
          dir: lang === "ar" ? ("rtl" as const) : ("ltr" as const),
          lang,
          onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onChange({ ...value, [lang]: event.target.value }),
        };
        const label = t(field, { language: t(`layout.language.${lang}`) });
        return (
          <Field key={lang} label={label}>
            {multiline ? <Textarea {...props} rows={4} /> : <Input {...props} />}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

const ACTIONS = ["none", "agenda", "maps", "shop", "quest", "link"] as const;

function startOf(type: (typeof ACTIONS)[number]): TapAction {
  if (type === "quest") return { type, questId: "" };
  if (type === "link") return { type, url: "" };
  return { type };
}

/** What a tap opens: a screen, one quest, or a web link. A quick link must open something, so it has no "Nothing". */
export function ActionPicker({
  language,
  action,
  allowNone,
  quests,
  onChange,
}: Readonly<{
  language: Language;
  action: TapAction;
  allowNone: boolean;
  quests: readonly PickOption[];
  onChange: (next: TapAction) => void;
}>) {
  const t = useTranslator(language);
  const known = action.type !== "quest" || quests.some((quest) => quest.id === action.questId);
  return (
    <>
      <Field label={t("layout.field.action")}>
        <Select
          value={action.type}
          onChange={(event) => onChange(startOf(event.target.value as (typeof ACTIONS)[number]))}
        >
          {ACTIONS.filter((kind) => allowNone || kind !== "none").map((kind) => (
            <option key={kind} value={kind}>
              {t(`layout.action.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      {action.type === "quest" ? (
        <Field label={t("layout.field.quest")}>
          <Select
            value={action.questId}
            onChange={(event) => onChange({ type: "quest", questId: event.target.value })}
          >
            <option value="">{t("layout.choose")}</option>
            {known || action.questId === "" ? null : (
              <option value={action.questId}>{action.questId}</option>
            )}
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {action.type === "link" ? (
        <Field label={t("layout.field.url")}>
          <Input
            type="url"
            dir="ltr"
            placeholder="https://"
            maxLength={LINK_URL_MAX}
            value={action.url}
            onChange={(event) => onChange({ type: "link", url: event.target.value })}
          />
        </Field>
      ) : null}
    </>
  );
}
