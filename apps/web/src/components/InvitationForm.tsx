"use client";
import {
  INVITATION_HISTORIES,
  INVITATION_MAX_INTERESTS,
  type City,
  type Interest,
  type InvitationRequestBody,
  type Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { NumberField } from "#src/components/NumberField.tsx";
import { cityChoices, cityName } from "#src/lib/cities.ts";
import { interestChoices, interestName, toggleInterest } from "#src/lib/interests.ts";
import {
  BLANK_REQUEST,
  requestBodyOf,
  type DraftProblem,
  type RequestDraft,
} from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type FieldProps = Readonly<{
  language: Language;
  draft: RequestDraft;
  busy: boolean;
  change: (patch: Partial<RequestDraft>) => void;
}>;
type Catalogs = Readonly<{ cities: readonly City[]; interests: readonly Interest[] }>;

function CityField({
  language,
  draft,
  busy,
  change,
  cities,
}: FieldProps & Pick<Catalogs, "cities">) {
  const t = translatorFor(language);
  return (
    <label className={styles.field}>
      {t("invCampaign.field.city")}
      <select
        className={styles.input}
        value={draft.cityId}
        disabled={busy}
        onChange={(changed) => change({ cityId: changed.target.value })}
      >
        <option value="">{t("invCampaign.city.any")}</option>
        {cityChoices(cities, draft.cityId === "" ? null : draft.cityId).map((city) => (
          <option key={city.id} value={city.id}>
            {cityName(city, language)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Up to three interests, any of them; the ones beyond the limit are disabled (the event form's rule). */
function InterestsField({
  language,
  draft,
  busy,
  change,
  interests,
}: FieldProps & Pick<Catalogs, "interests">) {
  const t = translatorFor(language);
  const full = draft.interests.length >= INVITATION_MAX_INTERESTS;
  return (
    <fieldset className={styles.row}>
      <legend>{t("invCampaign.field.interests")}</legend>
      {interestChoices(interests, draft.interests).map((interest) => {
        const ticked = draft.interests.includes(interest.id);
        return (
          <label key={interest.id} className={styles.check}>
            <input
              type="checkbox"
              checked={ticked}
              disabled={busy || (full && !ticked)}
              onChange={() => change({ interests: toggleInterest(draft.interests, interest.id) })}
            />
            <span>{interestName(interest, language)}</span>
          </label>
        );
      })}
      <p className={styles.muted}>{t("invCampaign.interests.hint")}</p>
    </fieldset>
  );
}

function HistoryField({ language, draft, busy, change }: FieldProps) {
  const t = translatorFor(language);
  return (
    <label className={styles.field}>
      {t("invCampaign.field.history")}
      <select
        className={styles.input}
        value={draft.history}
        disabled={busy}
        onChange={(changed) => {
          const history = INVITATION_HISTORIES.find((one) => one === changed.target.value);
          if (history !== undefined) {
            change({ history });
          }
        }}
      >
        {INVITATION_HISTORIES.map((history) => (
          <option key={history} value={history}>
            {t(`invCampaign.history.${history}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A line under a field: its hint, or what is wrong with it. */
function Hint({ wrong, hint, error }: Readonly<{ wrong: boolean; hint: string; error: string }>) {
  return wrong ? (
    <p role="alert" className={styles.alert}>
      {error}
    </p>
  ) : (
    <p className={styles.muted}>{hint}</p>
  );
}

type Props = Readonly<{
  language: Language;
  catalogs: Catalogs;
  /** A list could not be read, so some choices are missing. */
  catalogsFailed: boolean;
  busy: boolean;
  /** Asks for the invitations; true when it was made (the form then empties). */
  submit: (body: InvitationRequestBody) => Promise<boolean>;
  /** The draft changed, so the page's last message no longer applies. */
  edited: () => void;
}>;

/** The owner's request (FR-738): who to invite (all optional), how many, and the earliest send in Riyadh time. */
export function InvitationForm({
  language,
  catalogs,
  catalogsFailed,
  busy,
  submit,
  edited,
}: Props) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(BLANK_REQUEST);
  const [wrong, setWrong] = useState<DraftProblem | null>(null);
  const change = (patch: Partial<RequestDraft>) => {
    setDraft({ ...draft, ...patch });
    setWrong(null);
    edited();
  };
  const send = async (submitted: FormEvent) => {
    submitted.preventDefault();
    const checked = requestBodyOf(draft);
    if ("problem" in checked) {
      setWrong(checked.problem);
    } else if (await submit(checked.body)) {
      setDraft(BLANK_REQUEST);
    }
  };
  const fields = { language, draft, busy, change };
  return (
    <form
      className={styles.formCard}
      aria-labelledby="invitation-form-title"
      onSubmit={(submitted) => void send(submitted)}
    >
      <h2 id="invitation-form-title" className={styles.subtitle}>
        {t("invCampaign.form.title")}
      </h2>
      <CityField {...fields} cities={catalogs.cities} />
      <InterestsField {...fields} interests={catalogs.interests} />
      {catalogsFailed ? (
        <p role="alert" className={styles.alert}>
          {t("invCampaign.catalogsFailed")}
        </p>
      ) : null}
      <HistoryField {...fields} />
      <NumberField
        label={t("invCampaign.field.size")}
        value={draft.size}
        invalid={wrong === "size"}
        disabled={busy}
        change={(size) => change({ size })}
      />
      <Hint
        wrong={wrong === "size"}
        hint={t("invCampaign.size.hint")}
        error={t("invCampaign.invalid.size")}
      />
      <label className={styles.field}>
        {t("invCampaign.field.sendAfter")}
        <input
          className={styles.input}
          type="datetime-local"
          dir="ltr"
          value={draft.sendAfter}
          disabled={busy}
          aria-invalid={wrong === "sendAfter"}
          onChange={(changed) => change({ sendAfter: changed.target.value })}
        />
      </label>
      <Hint
        wrong={wrong === "sendAfter"}
        hint={t("invCampaign.sendAfter.hint")}
        error={t("invCampaign.invalid.sendAfter")}
      />
      <button type="submit" className={styles.button} disabled={busy}>
        {t("invCampaign.submit")}
      </button>
    </form>
  );
}
