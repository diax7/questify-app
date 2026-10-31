"use client";

import {
  SESSION_ACCESS,
  SESSION_KINDS,
  SESSION_LIMITS,
  termFor,
  type Language,
  type SessionBody,
  type SessionWindow,
} from "@questify/shared";
import { useState } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import { sessionIssueKey, sessionPayload, type SessionDraft } from "#src/lib/sessions.ts";
import type { QuestChoice } from "#src/lib/use-sessions.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  initial: SessionDraft;
  editing: boolean;
  /** Players already checked in (an edit): the points field then says they keep what they got. */
  attended: number;
  zone: string;
  window: SessionWindow;
  quests: readonly QuestChoice[];
  busy: boolean;
  problem: string | null;
  cancel: () => void;
  save: (body: SessionBody) => void;
}>;

type Change = <K extends keyof SessionDraft>(key: K, value: SessionDraft[K]) => void;

function TextPairs({
  draft,
  change,
  busy,
  language,
}: Readonly<{ draft: SessionDraft; change: Change; busy: boolean; language: Language }>) {
  const t = useTranslator(language);
  const pair = (
    ar: "titleAr" | "descriptionAr" | "placeAr",
    en: "titleEn" | "descriptionEn" | "placeEn",
    area: boolean,
  ) => (
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
          <Field key={key} label={t(`sessions.page.${key}`)}>
            {area ? (
              <Textarea {...props} rows={3} maxLength={SESSION_LIMITS.description} />
            ) : (
              <Input {...props} maxLength={SESSION_LIMITS.title} />
            )}
          </Field>
        );
      })}
    </FieldGroup>
  );
  return (
    <>
      {pair("titleAr", "titleEn", false)}
      {pair("descriptionAr", "descriptionEn", true)}
      {pair("placeAr", "placeEn", false)}
    </>
  );
}

function WhenFields({
  draft,
  change,
  busy,
  zone,
  language,
}: Readonly<{
  draft: SessionDraft;
  change: Change;
  busy: boolean;
  zone: string;
  language: Language;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      <Field label={`${t("sessions.page.startsAt")} (${zone})`}>
        <Input
          type="datetime-local"
          required
          disabled={busy}
          value={draft.startsAt}
          onChange={(event) => change("startsAt", event.target.value)}
        />
      </Field>
      <Field label={`${t("sessions.page.endsAt")} (${zone})`}>
        <Input
          type="datetime-local"
          required
          disabled={busy}
          value={draft.endsAt}
          onChange={(event) => change("endsAt", event.target.value)}
        />
      </Field>
    </FieldGroup>
  );
}

function RegistrationFields({
  draft,
  change,
  busy,
  zone,
  language,
}: Readonly<{
  draft: SessionDraft;
  change: Change;
  busy: boolean;
  zone: string;
  language: Language;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <FieldGroup layout="columns">
        <Field label={t("sessions.page.seats")}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={SESSION_LIMITS.seats}
            placeholder={t("sessions.page.seatsNone")}
            disabled={busy}
            value={draft.seats}
            onChange={(event) => change("seats", event.target.value)}
          />
        </Field>
        <Field label={`${t("sessions.page.closesAt")} (${zone})`}>
          <Input
            type="datetime-local"
            disabled={busy}
            value={draft.closesAt}
            onChange={(event) => change("closesAt", event.target.value)}
          />
        </Field>
      </FieldGroup>
      <Checkbox
        label={t("sessions.page.walkIns")}
        disabled={busy}
        checked={draft.walkIns}
        onChange={(event) => change("walkIns", event.target.checked)}
      />
    </>
  );
}

function ChoiceFields({
  draft,
  change,
  busy,
  language,
}: Readonly<{ draft: SessionDraft; change: Change; busy: boolean; language: Language }>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      <Field label={t("sessions.page.kind")}>
        <Select
          disabled={busy}
          value={draft.kind}
          onChange={(event) => change("kind", event.target.value as SessionDraft["kind"])}
        >
          {SESSION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`sessions.page.kind.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("sessions.page.access")}>
        <Select
          disabled={busy}
          value={draft.access}
          onChange={(event) => change("access", event.target.value as SessionDraft["access"])}
        >
          {SESSION_ACCESS.map((access) => (
            <option key={access} value={access}>
              {t(`sessions.page.access.${access}`)}
            </option>
          ))}
        </Select>
      </Field>
    </FieldGroup>
  );
}

/** The points a check-in pays (FR-1791, T-505b); a change applies to later check-ins only. */
function PointsField({
  draft,
  change,
  busy,
  attended,
  language,
}: Readonly<{
  draft: SessionDraft;
  change: Change;
  busy: boolean;
  attended: number;
  language: Language;
}>) {
  const t = useTranslator(language);
  const terms = useEventTerms();
  return (
    <Field
      label={t("sessions.page.points", { currency: termFor(terms.currency, language) })}
      help={attended > 0 ? t("sessions.page.pointsNote") : undefined}
    >
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={SESSION_LIMITS.points}
        placeholder="0"
        disabled={busy}
        value={draft.points}
        onChange={(event) => change("points", event.target.value)}
      />
    </Field>
  );
}

function ExtraFields({
  draft,
  change,
  busy,
  quests,
  language,
}: Readonly<{
  draft: SessionDraft;
  change: Change;
  busy: boolean;
  quests: readonly QuestChoice[];
  language: Language;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      {draft.access === "registration" ? (
        <Field label={t("sessions.page.reminder")}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            placeholder={String(SESSION_LIMITS.reminderMinutes.default)}
            disabled={busy}
            value={draft.reminderMinutes}
            onChange={(event) => change("reminderMinutes", event.target.value)}
          />
        </Field>
      ) : null}
      {quests.length === 0 ? null : (
        <Field label={t("sessions.page.quest")}>
          <Select
            disabled={busy}
            value={draft.questId}
            onChange={(event) => change("questId", event.target.value)}
          >
            <option value="">{t("sessions.page.questNone")}</option>
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </FieldGroup>
  );
}

export function SessionForm(props: Props) {
  const { language, busy, zone } = props;
  const t = useTranslator(language);
  const [draft, setDraft] = useState(props.initial);
  const [shown, setShown] = useState<string | null>(null);
  const change: Change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = () => {
    const payload = sessionPayload(draft, zone, props.window);
    if (payload.ok) {
      setShown(null);
      props.save(payload.body);
    } else setShown(t(sessionIssueKey(payload.issue)));
  };
  const problem = shown ?? props.problem;
  return (
    <Section title={t(props.editing ? "sessions.page.edit" : "sessions.page.add")}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ChoiceFields draft={draft} change={change} busy={busy} language={language} />
        <TextPairs draft={draft} change={change} busy={busy} language={language} />
        <Field label={t("sessions.page.speakers")}>
          <Textarea
            rows={3}
            disabled={busy}
            value={draft.speakers}
            onChange={(event) => change("speakers", event.target.value)}
          />
        </Field>
        <WhenFields draft={draft} change={change} busy={busy} zone={zone} language={language} />
        {draft.access === "registration" ? (
          <RegistrationFields
            draft={draft}
            change={change}
            busy={busy}
            zone={zone}
            language={language}
          />
        ) : null}
        <PointsField
          draft={draft}
          change={change}
          busy={busy}
          attended={props.attended}
          language={language}
        />
        <ExtraFields
          draft={draft}
          change={change}
          busy={busy}
          quests={props.quests}
          language={language}
        />
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <Toolbar align="end">
          <Button variant="secondary" disabled={busy} onClick={props.cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("sessions.page.save")}
          </Button>
        </Toolbar>
      </Form>
    </Section>
  );
}
