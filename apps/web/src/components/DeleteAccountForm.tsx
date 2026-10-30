"use client";

import { toWesternDigits, type Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { deletionTokenOf, pendingOf, textIn, type PendingPrize } from "#src/lib/deletion.ts";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Radio } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { BulletList, Card, Section, Stack, SubHeading } from "#src/ui/Section.tsx";

type Step =
  | Readonly<{ step: "contact" }>
  | Readonly<{ step: "code"; challengeToken: string }>
  | Readonly<{ step: "confirm"; deletionToken: string; pending: readonly PendingPrize[] }>
  | Readonly<{ step: "done" }>;

type StepProps<S extends Step["step"]> = Readonly<{
  language: Language;
  state: Extract<Step, { step: S }>;
  busy: boolean;
  submit: (path: string, payload: object) => Promise<unknown>;
}>;

function ContactStep({ language, busy, submit }: StepProps<"contact">) {
  const t = translatorFor(language);
  const [channel, setChannel] = useState<"phone" | "email">("phone");
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
    void submit("/v1/deletion/code", { channel, value: toWesternDigits(value), lang: language });
  };
  return (
    <Form onSubmit={send}>
      <FieldGroup layout="choiceGrid">
        {(["phone", "email"] as const).map((option) => (
          <Radio
            key={option}
            name="channel"
            checked={channel === option}
            onChange={() => setChannel(option)}
            disabled={busy}
            label={t(option === "phone" ? "signIn.phone" : "signIn.email")}
          />
        ))}
      </FieldGroup>
      <Field label={t(channel === "phone" ? "signIn.phone" : "signIn.email")}>
        <Input
          name="value"
          type={channel === "phone" ? "tel" : "email"}
          dir="ltr"
          autoComplete={channel === "phone" ? "tel" : "email"}
          required
          disabled={busy}
        />
      </Field>
      <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
        {t("deletion.sendCode")}
      </Button>
    </Form>
  );
}

function CodeStep({ language, state, busy, submit }: StepProps<"code">) {
  const t = translatorFor(language);
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    void submit("/v1/deletion/verify", {
      challengeToken: state.challengeToken,
      code: toWesternDigits(code),
    });
  };
  return (
    <Form onSubmit={send}>
      <Notice tone="info" role="status">
        {t("deletion.codeSentMaybe")}
      </Notice>
      <Field label={t("signIn.code")}>
        <Input
          name="code"
          inputMode="numeric"
          dir="ltr"
          autoComplete="one-time-code"
          maxLength={6}
          required
          disabled={busy}
        />
      </Field>
      <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
        {t("signIn.verify")}
      </Button>
    </Form>
  );
}

function ConfirmStep({ language, state, busy, submit }: StepProps<"confirm">) {
  const t = translatorFor(language);
  const [forfeit, setForfeit] = useState(false);
  const blocked = state.pending.length > 0 && !forfeit;
  return (
    <FieldGroup>
      {state.pending.length === 0 ? null : (
        <Card as="section" aria-labelledby="pending-title">
          <SubHeading as="h2" id="pending-title">
            {t("deletion.pendingTitle")}
          </SubHeading>
          <BulletList>
            {state.pending.map((prize) => (
              <li key={prize.redemptionId} dir="auto">
                {`${textIn(prize.item, language)} · ${textIn(prize.event, language)}`}
                {prize.rankPrize ? ` · ${t("deletion.rankPrize")}` : ""}
              </li>
            ))}
          </BulletList>
          <Muted>{t("deletion.pendingBody")}</Muted>
          <Checkbox
            checked={forfeit}
            onChange={(ticked) => setForfeit(ticked.target.checked)}
            disabled={busy}
            label={t("deletion.forfeit")}
          />
        </Card>
      )}
      <SubHeading as="h2">{t("deletion.confirmTitle")}</SubHeading>
      <Button
        variant="primary"
        disabled={busy || blocked}
        aria-busy={busy}
        onClick={() =>
          void submit("/v1/deletion/confirm", { deletionToken: state.deletionToken, forfeit })
        }
      >
        {t("deletion.confirm")}
      </Button>
    </FieldGroup>
  );
}

/** The next step after a successful answer to a step's request. */
function nextStep(state: Step, body: unknown): Step {
  if (state.step === "contact") {
    const token =
      typeof body === "object" && body !== null && "challengeToken" in body
        ? String(body.challengeToken)
        : "";
    return { step: "code", challengeToken: token };
  }
  if (state.step === "code") {
    const deletionToken = deletionTokenOf(body) ?? "";
    const pending =
      typeof body === "object" && body !== null && "pending" in body ? pendingOf(body.pending) : [];
    return { step: "confirm", deletionToken, pending };
  }
  return { step: "done" };
}

/**
 * The account deletion page (FR-127, store gates §2.5 and 5.1.1(v)): works without the app. The contact, a code sent
 * to it (the page never says whether an account uses it), the prizes still waiting, then the deletion.
 */
export function DeleteAccountForm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<Step>({ step: "contact" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (path: string, payload: object): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const result = await postJson(path, payload);
    setBusy(false);
    if (result.ok) {
      setState(nextStep(state, result.body));
      return;
    }
    const code = errorCodeOf(result.body);
    if (code === "deletion_expired") {
      setState({ step: "contact" });
    }
    if (code === "handover_pending" && state.step === "confirm") {
      const details = (result.body as { details?: { pending?: unknown } }).details;
      setState({ ...state, pending: pendingOf(details?.pending) });
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  const props = { language, busy, submit };
  return (
    <Stack as="section" aria-labelledby="deletion-title">
      <PageHeader titleId="deletion-title" title={t("deletion.title")} />
      <p>{t("deletion.intro")}</p>
      <Section title={t("deletion.removedTitle")}>
        <p>{t("deletion.removed")}</p>
      </Section>
      <Section title={t("deletion.keptTitle")}>
        <p>{t("deletion.kept")}</p>
      </Section>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {state.step === "done" ? null : (
        <Card>
          {state.step === "contact" ? <ContactStep {...props} state={state} /> : null}
          {state.step === "code" ? <CodeStep {...props} state={state} /> : null}
          {state.step === "confirm" ? <ConfirmStep {...props} state={state} /> : null}
        </Card>
      )}
      {state.step === "done" ? (
        <Notice tone="info" role="status">
          {t("deletion.done")}
        </Notice>
      ) : null}
    </Stack>
  );
}
