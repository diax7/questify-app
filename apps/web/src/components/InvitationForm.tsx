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
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { SubHeading } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

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
    <Field label={t("invCampaign.field.city")}>
      <Select
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
      </Select>
    </Field>
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
    <FieldGroup legend={t("invCampaign.field.interests")} layout="choiceGrid">
      {interestChoices(interests, draft.interests).map((interest) => {
        const ticked = draft.interests.includes(interest.id);
        return (
          <Checkbox
            key={interest.id}
            checked={ticked}
            disabled={busy || (full && !ticked)}
            onChange={() => change({ interests: toggleInterest(draft.interests, interest.id) })}
            label={interestName(interest, language)}
          />
        );
      })}
    </FieldGroup>
  );
}

function HistoryField({ language, draft, busy, change }: FieldProps) {
  const t = translatorFor(language);
  return (
    <Field label={t("invCampaign.field.history")}>
      <Select
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
      </Select>
    </Field>
  );
}

/** A line under a field: its hint, or what is wrong with it. */
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
    <Form
      card
      aria-labelledby="invitation-form-title"
      onSubmit={(submitted) => void send(submitted)}
    >
      <SubHeading as="h2" id="invitation-form-title">
        {t("invCampaign.form.title")}
      </SubHeading>
      <CityField {...fields} cities={catalogs.cities} />
      <InterestsField {...fields} interests={catalogs.interests} />
      {catalogsFailed ? (
        <Notice tone="danger" role="alert">
          {t("invCampaign.catalogsFailed")}
        </Notice>
      ) : null}
      <HistoryField {...fields} />
      <NumberField
        label={t("invCampaign.field.size")}
        value={draft.size}
        invalid={wrong === "size"}
        help={t("invCampaign.size.hint")}
        error={t("invCampaign.invalid.size")}
        disabled={busy}
        change={(size) => change({ size })}
      />
      <Field
        label={t("invCampaign.field.sendAfter")}
        info={<InfoTip label={t("common.info")}>{t("invCampaign.sendAfter.hint")}</InfoTip>}
        error={wrong === "sendAfter" ? t("invCampaign.invalid.sendAfter") : undefined}
      >
        <Input
          type="datetime-local"
          dir="ltr"
          value={draft.sendAfter}
          disabled={busy}
          aria-invalid={wrong === "sendAfter"}
          onChange={(changed) => change({ sendAfter: changed.target.value })}
        />
      </Field>
      <Button variant="primary" type="submit" disabled={busy}>
        {t("invCampaign.submit")}
      </Button>
    </Form>
  );
}
