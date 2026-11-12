"use client";

import {
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isLivePoll,
  termFor,
  zoneLabel,
  type EventTerms,
  type Language,
  type MessageKey,
  type QuestType,
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
  flashPatch,
  listedTypes,
  toggledVerification,
  typeChangePatch,
  typedNumber,
} from "#src/lib/quest-form-rules.ts";
import {
  hasPlace,
  textFor,
  type Bilingual,
  type CategoryView,
  type QuestDraft,
} from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { Card, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** What a type does that its name does not say: shown by the info button beside the Type field (ADR-370). */
const TYPE_INFO: Readonly<Partial<Record<QuestType, MessageKey>>> = {
  location: "quests.location.note",
  meet: "quests.meet.note",
  game: "quests.game.note",
  quiz: "quests.quiz.note",
  vote: "quests.vote.note",
  challenge: "quests.challenge.note",
  survey: "quests.survey.note",
  share: "quests.share.note",
  passport: "quests.passport.note",
};

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
  /** Whether this server stores photos (T-301b): a submission quest may ask for one. */
  photosOn?: boolean;
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

type QuestPart = Readonly<{
  language: Language;
  draft: QuestDraft;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>;

/** The Type field: fixed once the quest exists, with the info button for the types that need one. */
function QuestTypeField({
  language,
  draft,
  busy,
  change,
  isNew,
  locationQuestsOn,
}: QuestPart & Readonly<{ isNew: boolean; locationQuestsOn: boolean }>) {
  const t = useTranslator(language);
  const typeKey = TYPE_INFO[draft.type];
  return (
    <Field label={t("quests.field.type")} info={typeKey && infoTip(t, typeKey)}>
      <Select
        value={draft.type}
        disabled={busy || !isNew}
        onChange={(event) => {
          const type = event.target.value as QuestDraft["type"];
          change(typeChangePatch(type, startingConfig(type)));
        }}
      >
        {listedTypes(QUEST_TYPE_NAMES, locationQuestsOn, draft.type).map((type) => (
          <option key={type} value={type}>
            {t(QUEST_TYPES[type].label)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function QuestCategoryField({
  language,
  draft,
  busy,
  change,
  categories,
}: QuestPart & Readonly<{ categories: readonly CategoryView[] }>) {
  const t = useTranslator(language);
  return (
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
  );
}

/** One of the four text boxes: Arabic ones read right to left, the long ones are text areas. */
function QuestTextField({
  language,
  draft,
  busy,
  change,
  field,
  max,
  long = false,
}: QuestPart &
  Readonly<{
    field: "titleAr" | "titleEn" | "descriptionAr" | "descriptionEn";
    max: number;
    long?: boolean;
  }>) {
  const t = useTranslator(language);
  const props = {
    dir: field.endsWith("Ar") ? "rtl" : "ltr",
    maxLength: max,
    value: draft[field],
    disabled: busy,
  } as const;
  return (
    <Field label={t(`quests.field.${field}`)}>
      {long ? (
        <Textarea
          {...props}
          rows={3}
          onChange={(event) => change({ [field]: event.target.value })}
        />
      ) : (
        <Input {...props} onChange={(event) => change({ [field]: event.target.value })} />
      )}
    </Field>
  );
}

/** The points the quest pays, named after the event's currency (FR-404). */
function QuestPointsField({
  language,
  draft,
  busy,
  change,
  terms,
}: QuestPart & Readonly<{ terms: EventTerms }>) {
  const t = useTranslator(language);
  return (
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
          const points = typedNumber(event.target.value);
          if (points !== undefined) {
            change({ points });
          }
        }}
      />
    </Field>
  );
}

/** What an existing quest shows under its fields: vote counts, survey results and the NFC tags panel. */
function QuestExtras({
  language,
  timeZone,
  busy,
  votesUrl,
  surveyUrl,
  nfcTags,
}: Pick<QuestPart, "language" | "busy"> &
  Pick<Props, "timeZone" | "votesUrl" | "surveyUrl" | "nfcTags">) {
  return (
    <>
      {votesUrl === null ? null : <VoteCounts language={language} url={votesUrl} />}
      {surveyUrl === null ? null : <SurveyResults language={language} url={surveyUrl} />}
      {nfcTags === null ? null : (
        <NfcTagsPanel language={language} timeZone={timeZone} readOnly={busy} {...nfcTags} />
      )}
    </>
  );
}

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
  photosOn = false,
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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save(draft);
  };
  const part = { language, draft, busy, change };
  return (
    <Card>
      <Form onSubmit={submit} aria-labelledby="quest-form-title">
        <SubHeading as="h2" id="quest-form-title" ref={heading} tabIndex={-1}>
          {isNew ? t("quests.formNew") : t("quests.formEdit")}
        </SubHeading>
        <QuestTypeField {...part} isNew={isNew} locationQuestsOn={locationQuestsOn} />
        <QuestCategoryField {...part} categories={categories} />
        <QuestTextField {...part} field="titleAr" max={120} />
        <QuestTextField {...part} field="titleEn" max={120} />
        <QuestTextField {...part} field="descriptionAr" max={2000} long />
        <QuestTextField {...part} field="descriptionEn" max={2000} long />
        <QuestPointsField {...part} terms={terms} />
        <ItemPicker
          language={language}
          items={items}
          hint="questItems.pickerQuest"
          busy={busy}
          value={draft.itemId}
          change={(itemId) => change({ itemId })}
        />
        <QuestRepeatField {...part} player={terms.player[language].one} />
        <FirstBonusFields
          language={language}
          terms={terms}
          draft={draft}
          busy={busy}
          change={change}
          save={save}
        />
        <FlashField {...part} />
        <QuestWindowFields {...part} timeZone={timeZone} />
        <TypeFields
          language={language}
          config={draft.config}
          disabled={busy}
          sent={draft.pollSent}
          photos={photosOn}
          change={(config) => change({ config })}
        />
        {hasPlace(draft.type) ? (
          <QuestPlaceFields language={language} draft={draft} disabled={busy} change={change} />
        ) : null}
        <QuestVerificationField {...part} />
        <QuestExtras
          language={language}
          timeZone={timeZone}
          busy={busy}
          votesUrl={votesUrl}
          surveyUrl={surveyUrl}
          nfcTags={nfcTags}
        />
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
}: QuestPart & Readonly<{ timeZone: string }>) {
  const t = useTranslator(language);
  if (isLivePoll(draft.type, draft.config) || draft.flashRunning) {
    return null;
  }
  return (
    <>
      {(["opensAt", "closesAt"] as const).map((key) => (
        <Field
          key={key}
          label={t(`quests.field.${key}`)}
          {...(key === "opensAt"
            ? {
                info: (
                  <InfoTip label={t("common.info")}>
                    {t("quests.field.windowHint", { zone: zoneLabel(timeZone, language) })}
                  </InfoTip>
                ),
              }
            : {})}
        >
          <Input
            type="datetime-local"
            dir="ltr"
            value={draft[key]}
            disabled={busy}
            onChange={(event) => change({ [key]: event.target.value })}
          />
        </Field>
      ))}
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
function FlashField({ language, draft, busy, change }: QuestPart) {
  const t = useTranslator(language);
  if (isLivePoll(draft.type, draft.config)) {
    return null;
  }
  return (
    <>
      <Checkbox
        label={t("quests.field.flash")}
        info={infoTip(t, "quests.field.flashHint")}
        checked={draft.flash}
        disabled={busy || draft.flashRunning}
        onChange={(event) => change(flashPatch(event.target.checked, draft))}
      />
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
}: QuestPart &
  Readonly<{
    /** The event's word for a player, singular («لكل طالب»). */
    player: string;
  }>) {
  const t = useTranslator(language);
  if (QUEST_TYPES[draft.type].oneTry) {
    return null;
  }
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
              const repeatCap = typedNumber(event.target.value);
              if (repeatCap !== undefined) {
                change({ repeatCap });
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

/** The methods that need setting up on another device: what to do is in the info button beside them. */
const VERIFICATION_INFO: Readonly<Partial<Record<QuestVerification, MessageKey>>> = {
  screen_qr: "quests.verification.screenQrHint",
  kiosk: "quests.verification.kioskHint",
};

/** FR-301: how a scan quest is verified, at least one way; a type with no method shows nothing. */
function QuestVerificationField({ language, draft, busy, change }: QuestPart) {
  const t = useTranslator(language);
  const offered: readonly QuestVerification[] = QUEST_TYPES[draft.type].verifications;
  // Nothing to choose: no method, or a challenge's one fixed method (ADR-197).
  if (offered.length < 2) {
    return null;
  }
  // NFC keeps the quest QR on as its backup (FR-313): ticking it ticks the QR, which can't be unticked while it stays.
  // The screen QR never sits beside a printed code (ADR-240): ticking one side unticks the other.
  const nfc = draft.verification.includes("nfc");
  const toggle = (method: QuestVerification, on: boolean) =>
    change({ verification: toggledVerification(offered, draft.verification, method, on) });
  return (
    <FieldGroup legend={t("quests.verification")} layout="choices">
      {offered.map((method) => {
        const infoKey = VERIFICATION_INFO[method];
        return (
          <Checkbox
            key={method}
            label={t(VERIFICATION_LABELS[method])}
            {...(infoKey === undefined ? {} : { info: infoTip(t, infoKey) })}
            checked={draft.verification.includes(method)}
            disabled={busy || (nfc && method === "quest_qr")}
            onChange={(event) => toggle(method, event.target.checked)}
          />
        );
      })}
    </FieldGroup>
  );
}
