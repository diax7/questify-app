"use client";

import {
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isLivePoll,
  parseVerification,
  termFor,
  zoneLabel,
  type EventTerms,
  type Language,
  type QuestVerification,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { FirstBonusFields } from "#src/components/FirstBonusFields.tsx";
import { ItemPicker, useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { QuestPlaceFields } from "#src/components/QuestPlaceFields.tsx";
import { QUEST_TYPE_FIELDS, startingConfig } from "#src/components/QuestTypeFields.tsx";
import { SurveyResults } from "#src/components/SurveyResults.tsx";
import { VoteCounts } from "#src/components/VoteCounts.tsx";
import { NfcTagsPanel } from "#src/components/NfcTagsPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { QuestItem } from "#src/lib/quest-items.ts";
import {
  hasPlace,
  textFor,
  type Bilingual,
  type CategoryView,
  type QuestDraft,
} from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { Card, SubHeading, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  /** The event's zone: the times are typed and shown in it. */
  timeZone: string;
  /** The event's words: the points field is named after its currency (FR-404). */
  terms: EventTerms;
  categories: readonly CategoryView[];
  /** The event's quest items, for the item picker (T-304d). */
  items: readonly QuestItem[];
  initial: QuestDraft;
  /** False when editing: a quest's type is fixed once it exists. */
  isNew: boolean;
  /** The platform's location switch (ADR-208): a new quest may be a location quest only while it is on. */
  locationQuestsOn: boolean;
  /** Where an existing vote quest's counts are read (ADR-195); null for anything else. */
  votesUrl: string | null;
  /** A survey quest's results, for the team (T-303). */
  surveyUrl: string | null;
  /**
   * An existing scan quest's Tags panel (T-308): the event's API path, where its tags may move, and whether NFC is on.
   * Shown with NFC on, and with it off while the quest still has tags (so they can be revoked); null otherwise.
   */
  nfcTags: Readonly<{
    eventApi: string;
    questId: string;
    targets: readonly Readonly<{ id: string; title: Bilingual }>[];
    nfcOn: boolean;
  }> | null;
  busy: boolean;
  save: (draft: QuestDraft) => void;
  cancel: () => void;
}>;

/** One quest's fields: the common ones, then its type's own (FR-1005, FR-1008, FR-225–227). */
export function QuestForm({
  language,
  timeZone,
  terms,
  categories,
  items,
  initial,
  isNew,
  locationQuestsOn,
  votesUrl,
  surveyUrl,
  nfcTags,
  busy,
  save,
  cancel,
}: Props) {
  const t = useTranslator(language);
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
      dir: key.endsWith("Ar") ? "rtl" : "ltr",
      maxLength: max,
      value: draft[key],
      disabled: busy,
    } as const;
    return (
      <Field label={t(`quests.field.${key}`)}>
        {long ? (
          <Textarea
            {...props}
            rows={3}
            onChange={(event) => change({ [key]: event.target.value })}
          />
        ) : (
          <Input {...props} onChange={(event) => change({ [key]: event.target.value })} />
        )}
      </Field>
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save(draft);
  };
  return (
    <Card>
      <Form onSubmit={submit} aria-labelledby="quest-form-title">
        <SubHeading as="h2" id="quest-form-title" ref={heading} tabIndex={-1}>
          {isNew ? t("quests.formNew") : t("quests.formEdit")}
        </SubHeading>
        <Field label={t("quests.field.type")}>
          <Select
            value={draft.type}
            disabled={busy || !isNew}
            onChange={(event) =>
              change({
                type: event.target.value as QuestDraft["type"],
                config: startingConfig(event.target.value as QuestDraft["type"]),
                // A meet quest starts able to pay its default daily cap (ADR-210).
                ...(event.target.value === "meet" ? { repeatCap: 10 } : {}),
                verification:
                  parseVerification(event.target.value as QuestDraft["type"], undefined) ?? [],
              })
            }
          >
            {QUEST_TYPE_NAMES.filter(
              (type) => type !== "location" || locationQuestsOn || draft.type === "location",
            ).map((type) => (
              <option key={type} value={type}>
                {t(QUEST_TYPES[type].label)}
              </option>
            ))}
          </Select>
        </Field>
        {isNew ? null : <Muted>{t("quests.field.typeFixed")}</Muted>}
        <Field label={t("quests.field.category")}>
          <Select
            value={draft.categoryId}
            disabled={busy}
            onChange={(event) => change({ categoryId: event.target.value })}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {textFor(category.name, language)}
              </option>
            ))}
          </Select>
        </Field>
        {text("titleAr", 120)}
        {text("titleEn", 120)}
        {text("descriptionAr", 2000, true)}
        {text("descriptionEn", 2000, true)}
        <Field label={t("quests.field.points", { currency: termFor(terms.currency, language) })}>
          <Input
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
        </Field>
        <ItemPicker
          language={language}
          items={items}
          hint="questItems.pickerQuest"
          busy={busy}
          value={draft.itemId}
          change={(itemId) => change({ itemId })}
        />
        {QUEST_TYPES[draft.type].oneTry ? null : (
          <QuestRepeatField
            language={language}
            player={terms.player[language].one}
            draft={draft}
            busy={busy}
            change={change}
          />
        )}
        <FirstBonusFields
          language={language}
          terms={terms}
          draft={draft}
          busy={busy}
          change={change}
          save={save}
        />
        {isLivePoll(draft.type, draft.config) ? null : (
          <FlashField language={language} draft={draft} busy={busy} change={change} />
        )}
        {isLivePoll(draft.type, draft.config) || draft.flashRunning ? null : (
          <QuestWindowFields
            language={language}
            timeZone={timeZone}
            draft={draft}
            busy={busy}
            change={change}
          />
        )}
        <TypeFields
          language={language}
          config={draft.config}
          disabled={busy}
          sent={draft.pollSent}
          change={(config) => change({ config })}
        />
        {hasPlace(draft.type) ? (
          <QuestPlaceFields language={language} draft={draft} disabled={busy} change={change} />
        ) : null}
        <QuestVerificationField language={language} draft={draft} busy={busy} change={change} />
        {votesUrl === null ? null : <VoteCounts language={language} url={votesUrl} />}
        {surveyUrl === null ? null : <SurveyResults language={language} url={surveyUrl} />}
        {nfcTags === null ? null : (
          <NfcTagsPanel language={language} timeZone={timeZone} readOnly={busy} {...nfcTags} />
        )}
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {isNew ? t("quests.create") : t("quests.save")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

/**
 * When the quest opens and closes, in the event's zone, and whether players see it. A live poll has none of these:
 * Send and Close set its window (T-306).
 */
function QuestWindowFields({
  language,
  timeZone,
  draft,
  busy,
  change,
}: Readonly<{
  language: Language;
  timeZone: string;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {(["opensAt", "closesAt"] as const).map((key) => (
        <Field key={key} label={t(`quests.field.${key}`)}>
          <Input
            type="datetime-local"
            dir="ltr"
            value={draft[key]}
            disabled={busy}
            onChange={(event) => change({ [key]: event.target.value })}
          />
        </Field>
      ))}
      <Muted>{t("quests.field.windowHint", { zone: zoneLabel(timeZone, language) })}</Muted>
      <Checkbox
        label={t("quests.field.visible")}
        checked={draft.visible}
        disabled={busy}
        onChange={(event) => change({ visible: event.target.checked })}
      />
    </>
  );
}

/**
 * "Flash quest" (T-307, FR-251): shown to players only inside its window. Ticked on a quest with no times, it becomes a
 * hidden draft to launch from the list. Once launched (or its window started) it stays one, with its window kept.
 */
function FlashField({
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
  const t = useTranslator(language);
  return (
    <>
      <Checkbox
        label={t("quests.field.flash")}
        checked={draft.flash}
        disabled={busy || draft.flashRunning}
        onChange={(event) =>
          change({
            flash: event.target.checked,
            ...(event.target.checked && (draft.opensAt === "" || draft.closesAt === "")
              ? { visible: false }
              : {}),
          })
        }
      />
      {draft.flash ? <Muted>{t("quests.field.flashHint")}</Muted> : null}
    </>
  );
}

/** "Can be done more than once", and how many times when it can (FR-227). */
function QuestRepeatField({
  language,
  player,
  draft,
  busy,
  change,
}: Readonly<{
  language: Language;
  /** The event's word for a player, singular («لكل طالب»). */
  player: string;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <Checkbox
        label={t("quests.field.repeatable")}
        checked={draft.repeatCap > 1}
        disabled={busy}
        onChange={(event) => change({ repeatCap: event.target.checked ? 2 : 1 })}
      />
      {draft.repeatCap > 1 ? (
        <Field label={t("quests.field.repeatCap", { player })}>
          <Input
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
        </Field>
      ) : null}
    </>
  );
}

const VERIFICATION_LABELS = {
  quest_qr: "quests.verification.questQr",
  my_qr: "quests.verification.myQr",
  nfc: "quests.verification.nfc",
  screen_qr: "quests.verification.screenQr",
  kiosk: "quests.verification.kiosk",
} as const;

const PRINTED: ReadonlySet<QuestVerification> = new Set(["quest_qr", "nfc"]);

/** Whether ticking `method` must untick `item`: the screen QR against a printed code or its NFC tag (ADR-240). */
const clashes = (method: QuestVerification, item: QuestVerification): boolean =>
  (method === "screen_qr" && PRINTED.has(item)) || (PRINTED.has(method) && item === "screen_qr");

/** FR-301: how a scan quest is verified, at least one way; a type with no method shows nothing. */
function QuestVerificationField({
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
  const t = useTranslator(language);
  const offered: readonly QuestVerification[] = QUEST_TYPES[draft.type].verifications;
  // Nothing to choose: no method, or a challenge's one fixed method (ADR-197).
  if (offered.length < 2) {
    return null;
  }
  // NFC keeps the quest QR on as its backup (FR-313): ticking it ticks the QR, which can't be unticked while it stays.
  // The screen QR never sits beside a printed code (ADR-240): ticking one side unticks the other.
  const nfc = draft.verification.includes("nfc");
  const screen = draft.verification.includes("screen_qr");
  const toggle = (method: QuestVerification, on: boolean) =>
    change({
      verification: offered.filter((item) => {
        if (item === method) {
          return on;
        }
        if (on && clashes(method, item)) {
          return false;
        }
        return draft.verification.includes(item) || (method === "nfc" && on && item === "quest_qr");
      }),
    });
  return (
    <FieldGroup legend={t("quests.verification")} layout="choices">
      {offered.map((method) => (
        <Checkbox
          key={method}
          label={t(VERIFICATION_LABELS[method])}
          checked={draft.verification.includes(method)}
          disabled={busy || (nfc && method === "quest_qr")}
          onChange={(event) => toggle(method, event.target.checked)}
        />
      ))}
      {nfc ? <Muted>{t("quests.verification.nfcHint")}</Muted> : null}
      {screen ? <Muted>{t("quests.verification.screenQrHint")}</Muted> : null}
      {draft.verification.includes("kiosk") ? (
        <Muted>{t("quests.verification.kioskHint")}</Muted>
      ) : null}
    </FieldGroup>
  );
}
