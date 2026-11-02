"use client";

import {
  STAFF_BRIEFING_BODY_MAX,
  STAFF_BRIEFING_FIELDS,
  STAFF_BRIEFING_TITLE_MAX,
  blankStaffBriefing,
  checkStaffBriefing,
  formatNumber,
  staffBriefingSentSchema,
  type Language,
  type StaffBriefingBody,
  type StaffBriefingField,
  type StaffBriefingView,
} from "@questify/shared";
import { useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { whenOf } from "#src/lib/inbox.ts";
import { fieldKey, issueKey } from "#src/lib/operator-activity.ts";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Textarea } from "#src/ui/Field.tsx";
import { Row, Rows, Section } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  /** The event's API path, `/v1/organizers/{o}/events/{e}`. */
  eventApi: string;
  /** How many operators the event has now: who the confirmation says will be told. */
  operators: number;
  briefings: readonly StaffBriefingView[];
  /** Runs after a send, so the history shows it. */
  sent: () => Promise<void>;
}>;

/**
 * Sends a briefing with an Idempotency-Key kept until the answer is final, so a dropped connection resends the same
 * message once. Answers whether it went out; `problem` holds why not.
 */
function useBriefingPress(language: Language, eventApi: string) {
  const t = useTranslator(language);
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const send = async (draft: StaffBriefingBody): Promise<number | undefined> => {
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setProblem(undefined);
    const answer = await requestJson("POST", `${eventApi}/operators/briefing`, draft, {
      "Idempotency-Key": key.current,
    });
    setBusy(false);
    if (!isTransientFailure(answer)) {
      key.current = null;
    }
    const sent = answer.ok ? staffBriefingSentSchema.safeParse(answer.body) : undefined;
    if (sent?.success === true) {
      return sent.data.recipients;
    }
    setProblem(describeProblem(answer.body, language, t).text);
    return undefined;
  };
  return { send, busy, problem };
}

/** The most characters a field takes. */
const maxOf = (field: StaffBriefingField): number =>
  field.startsWith("title") ? STAFF_BRIEFING_TITLE_MAX : STAFF_BRIEFING_BODY_MAX;

function BriefingFields({
  language,
  draft,
  disabled,
  change,
}: Readonly<{
  language: Language;
  draft: StaffBriefingBody;
  disabled: boolean;
  change: (draft: StaffBriefingBody) => void;
}>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      {STAFF_BRIEFING_FIELDS.map((field: StaffBriefingField) => {
        const title = field.startsWith("title");
        const props = {
          value: draft[field],
          disabled,
          dir: field.endsWith("Ar") ? ("rtl" as const) : ("ltr" as const),
          lang: field.endsWith("Ar") ? "ar" : "en",
          required: true,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            change({ ...draft, [field]: event.target.value }),
        };
        return (
          <Field
            key={field}
            id={`briefing-${field}`}
            label={t(fieldKey(field))}
            help={t("announcements.page.counter", {
              count: formatNumber(Array.from(draft[field]).length, language),
              max: maxOf(field),
            })}
          >
            {title ? <Input {...props} /> : <Textarea {...props} rows={3} />}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

function History({
  language,
  briefings,
}: Readonly<{ language: Language; briefings: readonly StaffBriefingView[] }>) {
  const t = useTranslator(language);
  if (briefings.length === 0) {
    return <EmptyState>{t("briefing.none")}</EmptyState>;
  }
  return (
    <Rows>
      {briefings.map((briefing) => (
        <Row
          key={briefing.id}
          main={
            <>
              <strong dir="auto">{language === "ar" ? briefing.titleAr : briefing.titleEn}</strong>
              <Muted dir="auto">{language === "ar" ? briefing.bodyAr : briefing.bodyEn}</Muted>
              <Muted>
                <time dateTime={briefing.sentAt} dir="ltr">
                  {whenOf(briefing.sentAt)}
                </time>
                {" · "}
                {t("briefing.told", { count: formatNumber(briefing.recipients, language) })}
              </Muted>
            </>
          }
        />
      ))}
    </Rows>
  );
}

/**
 * The staff briefing (T-617, FR-1844): a short message, in Arabic and English, that reaches the event's operators and no
 * player. The text is checked as an announcement's is, a confirmation says how many operators will be told, and the last
 * five messages sent are listed under the form.
 */
export function StaffBriefing({ language, eventApi, operators, briefings, sent }: Props) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState(blankStaffBriefing);
  const [confirming, setConfirming] = useState<StaffBriefingBody | undefined>(undefined);
  const [done, setDone] = useState<number | undefined>(undefined);
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const press = useBriefingPress(language, eventApi);

  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = checkStaffBriefing(draft);
    setDone(undefined);
    if (checked.ok) {
      setInvalid(undefined);
      setConfirming(checked.draft);
      return;
    }
    setInvalid(
      t("briefing.invalid", {
        field: t(fieldKey(checked.field)),
        issue: t(issueKey(checked.issue), { max: maxOf(checked.field) }),
      }),
    );
    document.getElementById(`briefing-${checked.field}`)?.focus();
  };
  const apply = async () => {
    if (confirming === undefined) {
      return;
    }
    const recipients = await press.send(confirming);
    if (recipients !== undefined) {
      setDone(recipients);
      setConfirming(undefined);
      setDraft(blankStaffBriefing());
      await sent();
    }
  };
  return (
    <Section level={3} title={t("briefing.title")}>
      <Form noValidate onSubmit={review}>
        {press.problem === undefined ? null : (
          <Notice tone="danger" role="alert">
            {press.problem}
          </Notice>
        )}
        {done === undefined ? null : (
          <Notice tone="success" role="status">
            {t("briefing.sent", { count: formatNumber(done, language) })}
          </Notice>
        )}
        <BriefingFields
          language={language}
          draft={draft}
          disabled={press.busy || confirming !== undefined}
          change={(changed) => {
            setInvalid(undefined);
            setDraft(changed);
          }}
        />
        {invalid === undefined ? null : (
          <Notice tone="danger" role="alert">
            {invalid}
          </Notice>
        )}
        <Button variant="primary" type="submit" disabled={press.busy || confirming !== undefined}>
          {t("briefing.send")}
        </Button>
      </Form>
      <History language={language} briefings={briefings} />
      {confirming === undefined ? null : (
        <ConfirmDialog
          language={language}
          title={t("briefing.confirmTitle")}
          body={t("briefing.confirmBody", { count: formatNumber(operators, language) })}
          confirmLabel={t("briefing.send")}
          noteLabel={null}
          busy={press.busy}
          cancel={() => setConfirming(undefined)}
          confirm={() => void apply()}
        />
      )}
    </Section>
  );
}
