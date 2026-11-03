"use client";

import {
  GROUP_PUSH_BODY_MAX,
  GROUP_PUSH_INTERESTS_MAX,
  GROUP_PUSH_TITLE_MAX,
  type City,
  type Interest,
  type Language,
} from "@questify/shared";
import styles from "#src/components/catalog.module.css";
import { cityChoices, cityName } from "#src/lib/cities.ts";
import type { PushCheck, PushDraft } from "#src/lib/console-group-push.ts";
import { interestChoices, interestName } from "#src/lib/interests.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { Checkbox, Field, FieldGroup, Input, Radio, Select, Textarea } from "#src/ui/Field.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { infoTip } from "#src/ui/info.tsx";

const LANGUAGES = ["en", "ar"] as const satisfies readonly Language[];

type FieldsProps = Readonly<{
  language: Language;
  draft: PushDraft;
  busy: boolean;
  change: (patch: Partial<PushDraft>) => void;
}>;
type Catalogs = Readonly<{ cities: readonly City[]; interests: readonly Interest[] }>;

const toggled = (chosen: readonly string[], id: string): readonly string[] =>
  chosen.includes(id) ? chosen.filter((one) => one !== id) : [...chosen, id];

/** Everyone in one event (found by its join code), or the players who opted in, in a city and holding any interest. */
export function AudienceFields({
  language,
  draft,
  busy,
  change,
  check,
  catalogs,
}: FieldsProps & Readonly<{ check: PushCheck; catalogs: Catalogs }>) {
  const t = translatorFor(language);
  const full = draft.interests.length >= GROUP_PUSH_INTERESTS_MAX;
  const refused = !check.ok && check.problems.has("joinCode");
  return (
    <FieldGroup legend={t("console.push.audience")} layout="stack" disabled={busy}>
      <Radio
        name="push-audience"
        checked={draft.kind === "event"}
        onChange={() => change({ kind: "event" })}
        label={t("console.push.audience.event")}
        info={infoTip(t, "console.push.audience.event.info")}
      />
      <Radio
        name="push-audience"
        checked={draft.kind === "promo"}
        onChange={() => change({ kind: "promo" })}
        label={t("console.push.audience.promo")}
        info={infoTip(t, "console.push.audience.promo.info")}
      />
      {draft.kind === "event" ? (
        <Field
          label={t("console.push.joinCode")}
          error={refused && draft.joinCode !== "" ? t("console.catalog.invalid") : undefined}
        >
          <Input
            dir="ltr"
            value={draft.joinCode}
            onChange={(event) => change({ joinCode: event.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field label={t("console.push.city")}>
            <Select
              value={draft.cityId}
              onChange={(event) => change({ cityId: event.target.value })}
            >
              <option value="">{t("console.push.city.any")}</option>
              {cityChoices(catalogs.cities, draft.cityId === "" ? null : draft.cityId).map(
                (city) => (
                  <option key={city.id} value={city.id}>
                    {cityName(city, language)}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <FieldGroup legend={t("console.push.interests")} layout="choiceGrid">
            {interestChoices(catalogs.interests, draft.interests).map((interest) => {
              const ticked = draft.interests.includes(interest.id);
              return (
                <Checkbox
                  key={interest.id}
                  checked={ticked}
                  disabled={full && !ticked}
                  onChange={() => change({ interests: toggled(draft.interests, interest.id) })}
                  label={interestName(interest, language)}
                />
              );
            })}
          </FieldGroup>
        </>
      )}
    </FieldGroup>
  );
}

/** The reasons the rules give for one field, in the admin's language, or nothing while the form is blank. */
function reasonsFor(check: PushCheck, shown: boolean, field: string, language: Language) {
  if (check.ok || !shown) return undefined;
  const keys = check.problems.get(field);
  if (keys === undefined) return undefined;
  const t = translatorFor(language);
  return keys.map((key) => t(key)).join(" ");
}

function TextBox({
  language,
  code,
  part,
  value,
  max,
  error,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  code: Language;
  part: "title" | "body";
  value: string;
  max: number;
  error: string | undefined;
  disabled: boolean;
  onChange: (next: string) => void;
}>) {
  const t = translatorFor(language);
  const label = `${t(part === "title" ? "console.push.title" : "console.push.text")} · ${t(`texts.language.${code}`)}`;
  const shared = {
    lang: code,
    dir: directionOf(code),
    value,
    disabled,
    "data-field": `${part}.${code}`,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  };
  return (
    <Field label={label} error={error}>
      {part === "title" ? <Input {...shared} /> : <Textarea rows={4} {...shared} />}
      <Muted>{t("console.push.count", { count: Array.from(value).length, max })}</Muted>
    </Field>
  );
}

/** The title and the text in both languages, each with its length and the reason it is refused. */
export function TextFields({
  language,
  draft,
  busy,
  change,
  check,
  shown,
}: FieldsProps & Readonly<{ check: PushCheck; shown: boolean }>) {
  const boxes = [
    ["title", "titleAr", "titleEn", GROUP_PUSH_TITLE_MAX],
    ["body", "bodyAr", "bodyEn", GROUP_PUSH_BODY_MAX],
  ] as const;
  return (
    <>
      {boxes.map(([part, arKey, enKey, max]) => (
        <div className={styles.pair} key={part}>
          {LANGUAGES.map((code) => {
            const key = code === "ar" ? arKey : enKey;
            return (
              <TextBox
                key={code}
                language={language}
                code={code}
                part={part}
                value={draft[key]}
                max={max}
                error={reasonsFor(check, shown, `${part}.${code}`, language)}
                disabled={busy}
                onChange={(next) => change({ [key]: next })}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}
