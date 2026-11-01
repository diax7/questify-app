"use client";

import {
  EVENT_TEXT_KEYS,
  EVENT_TEXT_MAX,
  readEventTexts,
  termFor,
  type EventTextKey,
  type EventTexts,
  type Language,
} from "@questify/shared";
import { useState } from "react";
import { LayoutPreviewPane } from "#src/components/LayoutPreviewPane.tsx";
import type { PreviewScreen } from "#src/components/PreviewScreens.tsx";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout-editor.module.css";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { previewOf } from "#src/lib/preview.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import {
  TEXT_LANGUAGES,
  bodyOf,
  differs,
  draftOf,
  isRenamed,
  problemOf,
  resetLabel,
  withText,
  type TextsDraft,
} from "#src/lib/texts-editor.ts";
import { usePreview, type PreviewSource } from "#src/lib/use-preview.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Input } from "#src/ui/Field.tsx";
import { IconButton, IconLink } from "#src/ui/IconControl.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Ids = Readonly<{ language: Language; organizerId: string; eventId: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Saves the labels and says what went wrong in words. Returns the labels the API stored, or null when it refused. */
function useTextsSave({ language, organizerId, eventId }: Ids) {
  const t = useTranslator(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (body: unknown): Promise<EventTexts | null> => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/texts`,
      body,
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return null;
    }
    if (result.ok && isRecord(result.body)) {
      return readEventTexts(result.body["texts"]);
    }
    setProblem(describeProblem(result.body, language, t).text);
    return null;
  };
  return { busy, problem, save };
}

/** The platform's text for a label in one language, with the event's own words filled in. */
function DefaultText({ name, language }: Readonly<{ name: EventTextKey; language: Language }>) {
  const terms = useEventTerms();
  return (
    <bdi lang={language} dir={directionOf(language)}>
      {translatorFor(language, terms)(name)}
    </bdi>
  );
}

/** One label: its Arabic and English boxes side by side, the platform's text as the placeholder, and a reset. */
function LabelRow({
  name,
  language,
  draft,
  busy,
  onChange,
  onReset,
}: Readonly<{
  name: EventTextKey;
  language: Language;
  draft: TextsDraft;
  busy: boolean;
  onChange: (boxLanguage: Language, text: string) => void;
  onReset: () => void;
}>) {
  const t = useTranslator(language);
  const terms = useEventTerms();
  return (
    <Row
      main={
        <FieldGroup legend={t(name)} layout="columns">
          {TEXT_LANGUAGES.map((boxLanguage) => {
            const value = draft[boxLanguage][name];
            return (
              <Field
                key={boxLanguage}
                label={t(`texts.language.${boxLanguage}`)}
                help={
                  value.trim() === "" ? undefined : (
                    <>
                      {t("texts.defaultLabel")}: <DefaultText name={name} language={boxLanguage} />
                    </>
                  )
                }
              >
                <Input
                  lang={boxLanguage}
                  dir={directionOf(boxLanguage)}
                  maxLength={EVENT_TEXT_MAX}
                  value={value}
                  placeholder={translatorFor(boxLanguage, terms)(name)}
                  disabled={busy}
                  onChange={(event) => onChange(boxLanguage, event.target.value)}
                />
              </Field>
            );
          })}
        </FieldGroup>
      }
    >
      {isRenamed(draft, name) ? (
        <IconButton
          icon="undo"
          label={t("texts.reset", { name: t(name) })}
          disabled={busy}
          onClick={onReset}
        />
      ) : null}
    </Row>
  );
}

/** The currency word has its own form (Event words); it is listed here so the whole set of names is in one place. */
function CurrencyRow({ language, organizerId, eventId }: Ids) {
  const t = useTranslator(language);
  const currency = useEventTerms().currency;
  return (
    <Row
      main={
        <>
          <strong>{t("texts.currency")}</strong>
          <Muted>
            <bdi lang="ar" dir="rtl">
              {termFor(currency, "ar")}
            </bdi>
            {" · "}
            <bdi lang="en" dir="ltr">
              {termFor(currency, "en")}
            </bdi>
          </Muted>
        </>
      }
    >
      <IconLink
        icon="edit"
        label={t("texts.currencyEdit")}
        href={`/${language}/organizers/${organizerId}/events/${eventId}`}
      />
    </Row>
  );
}

function Notes({
  language,
  wrong,
  problem,
  saved,
}: Readonly<{
  language: Language;
  wrong: ReturnType<typeof problemOf>;
  problem: string | null;
  saved: boolean;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {wrong === null ? null : (
        <Notice role="status" tone="warning">
          {t("texts.invalid", {
            name: t(wrong.key),
            language: t(`texts.language.${wrong.language}`),
          })}
        </Notice>
      )}
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      {saved ? (
        <Notice role="status" tone="success">
          {t("texts.saved")}
        </Notice>
      ) : null}
    </>
  );
}

function Workspace({ source, ...ids }: Ids & Readonly<{ source: PreviewSource }>) {
  const { language } = ids;
  const t = useTranslator(language);
  const { busy, problem, save } = useTextsSave(ids);
  const [stored, setStored] = useState(() => draftOf(readEventTexts(source.event.texts)));
  const [draft, setDraft] = useState(stored);
  const [done, setDone] = useState(false);
  const [screen, setScreen] = useState<PreviewScreen>("home");
  const [previewLanguage, setPreviewLanguage] = useState<Language>(language);
  const dirty = differs(draft, stored);
  const wrong = problemOf(draft);
  const edit = (next: TextsDraft) => {
    setDraft(next);
    setDone(false);
  };
  const preview = previewOf(
    { ...source.event, texts: bodyOf(draft) },
    source.categories,
    source.rewards,
    previewLanguage,
    source.hasRules,
  );
  const saveDraft = async () => {
    const texts = await save(bodyOf(draft));
    if (texts !== null) {
      const next = draftOf(texts);
      setStored(next);
      setDraft(next);
      setDone(true);
    }
  };
  return (
    <div className={styles.workspace}>
      <div className={styles.editor}>
        <Section title={t("texts.title")}>
          <Rows>
            {EVENT_TEXT_KEYS.map((name) => (
              <LabelRow
                key={name}
                name={name}
                language={language}
                draft={draft}
                busy={busy}
                onChange={(boxLanguage, text) => edit(withText(draft, boxLanguage, name, text))}
                onReset={() => edit(resetLabel(draft, name))}
              />
            ))}
            <CurrencyRow {...ids} />
          </Rows>
        </Section>
        <Toolbar>
          <Button
            variant="primary"
            disabled={!dirty || busy || wrong !== null}
            onClick={() => void saveDraft()}
          >
            {t("texts.save")}
          </Button>
          <Button variant="quiet" disabled={!dirty || busy} onClick={() => edit(stored)}>
            {t("layout.discard")}
          </Button>
        </Toolbar>
        <Notes language={language} wrong={wrong} problem={problem} saved={done && !dirty} />
      </div>
      <div className={styles.preview}>
        <Tabs
          label={t("texts.previewLanguage")}
          items={TEXT_LANGUAGES.map((key) => ({
            key,
            label: t(`texts.language.${key}`),
            current: key === previewLanguage,
            select: () => setPreviewLanguage(key),
          }))}
        />
        <LayoutPreviewPane
          preview={preview}
          language={previewLanguage}
          screen={screen}
          onScreen={setScreen}
        />
      </div>
    </div>
  );
}

/**
 * The labels an event renames (FR-1843, T-614): each approved name in Arabic and English, side by side, with Questify's
 * text as the placeholder and a reset to it, and the phone redrawn as the owner types. A blank box keeps the platform's
 * text. The currency word is listed with a link to its own form.
 */
export function EventTextsEditor(ids: Ids) {
  const t = useTranslator(ids.language);
  const read = usePreview(ids.organizerId, ids.eventId);
  return (
    <Stack>
      <PageHeader title={t("texts.title")} />
      {read.state === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {read.state === "failed" ? (
        <Notice role="alert" tone="danger">
          {t("preview.loadFailed")}
        </Notice>
      ) : null}
      {read.state === "ready" ? <Workspace {...ids} source={read.source} /> : null}
    </Stack>
  );
}
