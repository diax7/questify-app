"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clockOf, type SupportGrant } from "#src/lib/console-organizers.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import type { Suspension } from "#src/lib/staff-api.ts";
import { Button, type ButtonVariant } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";

const REASON_MIN = 10;
const REASON_MAX = 300;
export const keyed = () => ({ "idempotency-key": crypto.randomUUID() });

/** A reason long enough to send (the API checks again: 10 to 300 characters once trimmed). */
export const reasonReady = (reason: string): boolean => {
  const length = reason.trim().length;
  return length >= REASON_MIN && length <= REASON_MAX;
};

/** Runs one console write: busy while it runs, the API's own words when it is refused, `onDone` when it is not. */
export function useWrite(language: Language, onDone: (done: string) => void) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** `handled` takes a refusal the caller answers itself (a confirmation to ask), so no problem is shown for it. */
  const run = async (
    work: () => Promise<PostResult>,
    done: string,
    handled: (result: PostResult) => boolean = () => false,
  ): Promise<boolean> => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    setProblem(
      result.ok || handled(result)
        ? null
        : describeProblem(result.body, language, translatorFor(language)).text,
    );
    if (result.ok) {
      onDone(done);
    }
    return result.ok;
  };
  return { busy, problem, run };
}

export function Problem({ problem }: Readonly<{ problem: string | null }>) {
  return problem === null ? null : (
    <Notice tone="danger" role="alert">
      {problem}
    </Notice>
  );
}

/**
 * A button that asks once before it acts (ADR-063): the question in an alert with Cancel and the same action again.
 */
export function ConfirmedButton({
  language,
  label,
  question,
  variant,
  disabled,
  act,
}: Readonly<{
  language: Language;
  label: string;
  question: string;
  variant: ButtonVariant;
  disabled: boolean;
  act: () => void;
}>) {
  const t = translatorFor(language);
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Toolbar>
        <Button variant={variant} disabled={disabled} onClick={() => setAsking(true)}>
          {label}
        </Button>
      </Toolbar>
    );
  }
  return (
    <Notice tone="warning" as="div" role="alert">
      <p dir="auto">{question}</p>
      <Toolbar>
        <Button variant="quiet" disabled={disabled} onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </Button>
        <Button
          variant={variant}
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            act();
          }}
        >
          {label}
        </Button>
      </Toolbar>
    </Notice>
  );
}

export function ReasonField({
  language,
  label,
  reason,
  change,
}: Readonly<{
  language: Language;
  label: MessageKey;
  reason: string;
  change: (next: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Field label={t(label)} help={t("suspend.reasonHint")}>
      <Textarea
        maxLength={REASON_MAX}
        value={reason}
        onChange={(changed) => change(changed.target.value)}
      />
    </Field>
  );
}

type SuspensionProps = Readonly<{
  language: Language;
  kind: "organizer" | "event";
  id: string;
  name: string;
  suspension: Suspension | null;
  onChanged: (done: string) => void;
}>;

/** Suspends with a required reason the organizer will read (Q-372), after a confirmation. */
function SuspendForm({ language, kind, id, name, onChanged }: SuspensionProps) {
  const t = translatorFor(language);
  const [reason, setReason] = useState("");
  const { busy, problem, run } = useWrite(language, onChanged);
  const organizer = kind === "organizer";
  const path = `/v1/admin/${organizer ? "organizers" : "events"}/${id}/suspend`;
  return (
    <>
      <Muted>{t("suspend.active")}</Muted>
      <Problem problem={problem} />
      <ReasonField language={language} label="suspend.reason" reason={reason} change={setReason} />
      <ConfirmedButton
        language={language}
        label={t(organizer ? "suspend.organizer" : "suspend.event")}
        question={t(organizer ? "suspend.confirmOrganizer" : "suspend.confirmEvent", { name })}
        variant="danger"
        disabled={busy || !reasonReady(reason)}
        act={() =>
          void run(
            () => requestJson("POST", path, { reason: reason.trim() }, keyed()),
            t("suspend.done"),
          ).then((sent) => {
            if (sent) {
              setReason("");
            }
          })
        }
      />
    </>
  );
}

/** Lifts a suspension after one confirmation; everything comes back as it was. */
function ReactivateForm({
  language,
  kind,
  id,
  name,
  suspension,
  onChanged,
}: SuspensionProps & Readonly<{ suspension: Suspension }>) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onChanged);
  const path = `/v1/admin/${kind === "organizer" ? "organizers" : "events"}/${id}/reactivate`;
  return (
    <>
      <Muted dir="auto">
        {t("suspend.since", {
          time: clockOf(suspension.since, language),
          reason: suspension.reason,
        })}
      </Muted>
      <Problem problem={problem} />
      <ConfirmedButton
        language={language}
        label={t("suspend.reactivate")}
        question={t("suspend.confirmReactivate", { name })}
        variant="primary"
        disabled={busy}
        act={() => void run(() => requestJson("POST", path, {}, keyed()), t("suspend.reactivated"))}
      />
    </>
  );
}

/** Suspend or reactivate an organizer or one event (T-701, ADR-406). */
export function SuspensionPanel(props: SuspensionProps) {
  const t = translatorFor(props.language);
  return (
    <Section title={t("suspend.title")} level={3}>
      <Stack>
        {props.suspension === null ? (
          <SuspendForm {...props} />
        ) : (
          <ReactivateForm {...props} suspension={props.suspension} />
        )}
      </Stack>
    </Section>
  );
}

/** Who holds support access now; each grant can be ended, and your own opens the event's dashboard. */
function GrantRows({
  language,
  grants,
  busy,
  end,
  goTo,
}: Readonly<{
  language: Language;
  grants: readonly SupportGrant[];
  busy: boolean;
  end: (grant: SupportGrant) => void;
  goTo: () => void;
}>) {
  const t = translatorFor(language);
  if (grants.length === 0) {
    return <Muted>{t("support.none")}</Muted>;
  }
  return (
    <Rows>
      {grants.map((grant) => {
        const time = clockOf(grant.expiresAt, language);
        return (
          <Row
            key={grant.id}
            main={
              grant.mine
                ? t("support.mine", { time })
                : t("support.grant", { email: grant.adminEmail, time })
            }
          >
            <Button variant="quiet" disabled={busy} onClick={() => end(grant)}>
              {t("support.end")}
            </Button>
            {grant.mine ? (
              <Button variant="quiet" onClick={goTo}>
                {t("support.goTo")}
              </Button>
            ) : null}
          </Row>
        );
      })}
    </Rows>
  );
}

/**
 * Support access to one event (T-701, ADR-407): who holds it now, and opening it for yourself for 15 minutes with a
 * reason; once open, the event's own dashboard opens. The organizer is not told (Q-373).
 */
export function SupportPanel({
  language,
  eventId,
  organizerId,
  name,
  grants,
  onChanged,
}: Readonly<{
  language: Language;
  eventId: string;
  organizerId: string;
  name: string;
  grants: readonly SupportGrant[];
  onChanged: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const router = useRouter();
  const [reason, setReason] = useState("");
  const { busy, problem, run } = useWrite(language, onChanged);
  const goTo = () => router.push(`/${language}/organizers/${organizerId}/events/${eventId}`);
  const open = () =>
    void run(
      () =>
        requestJson(
          "POST",
          `/v1/admin/events/${eventId}/support`,
          { reason: reason.trim() },
          keyed(),
        ),
      t("support.title"),
    ).then((opened) => {
      if (opened) {
        goTo();
      }
    });
  const end = (grant: SupportGrant) =>
    void run(
      () => requestJson("POST", `/v1/admin/support/${grant.id}/close`, {}, keyed()),
      t("support.ended"),
    );
  return (
    <Section title={t("support.title")} level={3} description={t("support.intro")}>
      <Stack>
        <GrantRows language={language} grants={grants} busy={busy} end={end} goTo={goTo} />
        <Problem problem={problem} />
        <ReasonField
          language={language}
          label="support.reason"
          reason={reason}
          change={setReason}
        />
        <ConfirmedButton
          language={language}
          label={t("support.open")}
          question={t("support.confirm", { name })}
          variant="primary"
          disabled={busy || !reasonReady(reason)}
          act={open}
        />
      </Stack>
    </Section>
  );
}
