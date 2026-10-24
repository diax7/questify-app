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
import { ItemPicker, useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { QuestPlaceFields } from "#src/components/QuestPlaceFields.tsx";
import { QUEST_TYPE_FIELDS, startingConfig } from "#src/components/QuestTypeFields.tsx";
import { SurveyResults } from "#src/components/SurveyResults.tsx";
import { VoteCounts } from "#src/components/VoteCounts.tsx";
import { NfcTagsPanel } from "#src/components/NfcTagsPanel.tsx";
import { translatorFor } from "#src/lib/language.ts";
import type { QuestItem } from "#src/lib/quest-items.ts";
import {
  hasPlace,
  textFor,
  type Bilingual,
  type CategoryView,
  type QuestDraft,
} from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

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
  /** An existing NFC quest's Tags panel (T-308): the event's API path and where its tags may move; null otherwise. */
  nfcTags: Readonly<{
    eventApi: string;
    questId: string;
    targets: readonly Readonly<{ id: string; title: Bilingual }>[];
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
        {t("quests.field.points", { currency: termFor(terms.currency, language) })}
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
  const t = translatorFor(language);
  return (
    <>
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
  const t = translatorFor(language);
  return (
    <>
      <label className={styles.check}>
        <input
          type="checkbox"
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
        <span>{t("quests.field.flash")}</span>
      </label>
      {draft.flash ? <p className={styles.muted}>{t("quests.field.flashHint")}</p> : null}
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
          {t("quests.field.repeatCap", { player })}
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

const VERIFICATION_LABELS = {
  quest_qr: "quests.verification.questQr",
  my_qr: "quests.verification.myQr",
  nfc: "quests.verification.nfc",
} as const;

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
  const t = translatorFor(language);
  const offered: readonly QuestVerification[] = QUEST_TYPES[draft.type].verifications;
  // Nothing to choose: no method, or a challenge's one fixed method (ADR-197).
  if (offered.length < 2) {
    return null;
  }
  // NFC keeps the quest QR on as its backup (FR-313): ticking it ticks the QR, which can't be unticked while it stays.
  const nfc = draft.verification.includes("nfc");
  const toggle = (method: QuestVerification, on: boolean) =>
    change({
      verification: offered.filter((item) =>
        item === method
          ? on
          : draft.verification.includes(item) || (method === "nfc" && on && item === "quest_qr"),
      ),
    });
  return (
    <fieldset className={styles.field}>
      <legend>{t("quests.verification")}</legend>
      {offered.map((method) => (
        <label key={method} className={styles.check}>
          <input
            type="checkbox"
            checked={draft.verification.includes(method)}
            disabled={busy || (nfc && method === "quest_qr")}
            onChange={(event) => toggle(method, event.target.checked)}
          />
          <span>{t(VERIFICATION_LABELS[method])}</span>
        </label>
      ))}
      {nfc ? <p className={styles.muted}>{t("quests.verification.nfcHint")}</p> : null}
    </fieldset>
  );
}
