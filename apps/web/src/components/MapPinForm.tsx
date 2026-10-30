"use client";

import {
  MAP_AMENITIES,
  amenityKey,
  MAP_LIMITS,
  MAP_PIN_KINDS,
  type Language,
  type MapPinBody,
} from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { pinPayload, type PinDraft } from "#src/lib/maps.ts";
import type { QuestChoice } from "#src/lib/use-maps.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Change = <K extends keyof PinDraft>(key: K, value: PinDraft[K]) => void;
type Shared = Readonly<{ draft: PinDraft; change: Change; busy: boolean; language: Language }>;

function TextFields({ draft, change, busy, language }: Shared) {
  const t = useTranslator(language);
  const pair = (ar: "nameAr" | "detailsAr", en: "nameEn" | "detailsEn", area: boolean) => (
    <FieldGroup layout="columns">
      {([ar, en] as const).map((key) => {
        const props = {
          value: draft[key],
          disabled: busy,
          dir: key.endsWith("Ar") ? ("rtl" as const) : ("ltr" as const),
          lang: key.endsWith("Ar") ? "ar" : "en",
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            change(key, event.target.value),
        };
        return (
          <Field key={key} label={t(`maps.pin.${key}`)}>
            {area ? (
              <Textarea {...props} rows={3} maxLength={MAP_LIMITS.details} />
            ) : (
              <Input {...props} maxLength={MAP_LIMITS.name} />
            )}
          </Field>
        );
      })}
    </FieldGroup>
  );
  return (
    <>
      {pair("nameAr", "nameEn", false)}
      {pair("detailsAr", "detailsEn", true)}
    </>
  );
}

function PlaceFields({ draft, change, busy, language }: Shared) {
  const t = useTranslator(language);
  const field = (key: "x" | "y") => (
    <Field
      label={t(`maps.pin.${key}`)}
      {...(key === "x" ? { info: infoTip(t, "maps.page.boardHint") } : {})}
    >
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={0.1}
        required
        disabled={busy}
        value={draft[key]}
        onChange={(event) => change(key, event.target.value)}
      />
    </Field>
  );
  return (
    <FieldGroup layout="columns">
      {field("x")}
      {field("y")}
    </FieldGroup>
  );
}

function KindFields({
  draft,
  change,
  busy,
  language,
  quests,
}: Shared & Readonly<{ quests: readonly QuestChoice[] }>) {
  const t = useTranslator(language);
  return (
    <>
      <Field label={t("maps.pin.kind")}>
        <Select
          disabled={busy}
          value={draft.kind}
          onChange={(event) => change("kind", event.target.value as PinDraft["kind"])}
        >
          {MAP_PIN_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`maps.pin.kind.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      {draft.kind === "amenity" ? (
        <Field label={t("maps.pin.amenity")}>
          <Select
            disabled={busy}
            value={draft.amenity}
            onChange={(event) => change("amenity", event.target.value as PinDraft["amenity"])}
          >
            {MAP_AMENITIES.map((amenity) => (
              <option key={amenity} value={amenity}>
                {t(amenityKey(amenity))}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {draft.kind === "quest" ? (
        <Field label={t("maps.pin.quest")}>
          <Select
            required
            disabled={busy}
            value={draft.questId}
            onChange={(event) => change("questId", event.target.value)}
          >
            <option value="">{t("maps.pin.questNone")}</option>
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </>
  );
}

/**
 * The pin form: its kind, the fields that kind uses, and its place as two percentages (a click on the board fills them).
 * A quest pin has no name or details (the quest names it); an amenity's name is optional.
 */
export function MapPinForm({
  language,
  draft,
  editing,
  quests,
  busy,
  problem,
  change,
  cancel,
  save,
}: Readonly<{
  language: Language;
  draft: PinDraft;
  editing: boolean;
  quests: readonly QuestChoice[];
  busy: boolean;
  problem: string | null;
  change: Change;
  cancel: () => void;
  save: (body: MapPinBody) => void;
}>) {
  const t = useTranslator(language);
  const shared = { draft, change, busy, language };
  return (
    <Section title={t(editing ? "maps.pin.edit" : "maps.pin.add")} level={3}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          save(pinPayload(draft));
        }}
      >
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <KindFields {...shared} quests={quests} />
        {draft.kind === "quest" ? null : <TextFields {...shared} />}
        <PlaceFields {...shared} />
        <Toolbar align="end">
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("maps.pin.save")}
          </Button>
        </Toolbar>
      </Form>
    </Section>
  );
}
