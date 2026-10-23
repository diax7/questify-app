"use client";

import { toWesternDigits, type Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { deletionTokenOf, pendingOf, textIn, type PendingPrize } from "#src/lib/deletion.ts";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

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
    <form className={styles.form} onSubmit={send}>
      <p className={styles.muted}>{t("deletion.contactHint")}</p>
      <fieldset className={styles.row}>
        {(["phone", "email"] as const).map((option) => (
          <label key={option} className={styles.check}>
            <input
              type="radio"
              name="channel"
              checked={channel === option}
              onChange={() => setChannel(option)}
              disabled={busy}
            />
            <span>{t(option === "phone" ? "signIn.phone" : "signIn.email")}</span>
          </label>
        ))}
      </fieldset>
      <label className={styles.field}>
        <span>{t(channel === "phone" ? "signIn.phone" : "signIn.email")}</span>
        <input
          className={styles.input}
          name="value"
          type={channel === "phone" ? "tel" : "email"}
          dir="ltr"
          autoComplete={channel === "phone" ? "tel" : "email"}
          required
          disabled={busy}
        />
      </label>
      <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
        {t("deletion.sendCode")}
      </button>
    </form>
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
    <form className={styles.form} onSubmit={send}>
      <p role="status" className={styles.notice}>
        {t("deletion.codeSentMaybe")}
      </p>
      <p className={styles.muted}>{t("deletion.codeHint")}</p>
      <label className={styles.field}>
        <span>{t("signIn.code")}</span>
        <input
          className={styles.input}
          name="code"
          inputMode="numeric"
          dir="ltr"
          autoComplete="one-time-code"
          maxLength={6}
          required
          disabled={busy}
        />
      </label>
      <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
        {t("signIn.verify")}
      </button>
    </form>
  );
}

function ConfirmStep({ language, state, busy, submit }: StepProps<"confirm">) {
  const t = translatorFor(language);
  const [forfeit, setForfeit] = useState(false);
  const blocked = state.pending.length > 0 && !forfeit;
  return (
    <div className={styles.form}>
      {state.pending.length === 0 ? null : (
        <section aria-labelledby="pending-title" className={styles.card}>
          <h2 id="pending-title" className={styles.subtitle}>
            {t("deletion.pendingTitle")}
          </h2>
          <ul className={styles.list}>
            {state.pending.map((prize) => (
              <li key={prize.redemptionId} dir="auto">
                {`${textIn(prize.item, language)} · ${textIn(prize.event, language)}`}
                {prize.rankPrize ? ` · ${t("deletion.rankPrize")}` : ""}
              </li>
            ))}
          </ul>
          <p className={styles.muted}>{t("deletion.pendingBody")}</p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={forfeit}
              onChange={(ticked) => setForfeit(ticked.target.checked)}
              disabled={busy}
            />
            <span>{t("deletion.forfeit")}</span>
          </label>
        </section>
      )}
      <h2 className={styles.subtitle}>{t("deletion.confirmTitle")}</h2>
      <button
        type="button"
        className={styles.button}
        disabled={busy || blocked}
        aria-busy={busy}
        onClick={() =>
          void submit("/v1/deletion/confirm", { deletionToken: state.deletionToken, forfeit })
        }
      >
        {t("deletion.confirm")}
      </button>
    </div>
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
    <section className={styles.panel} aria-labelledby="deletion-title">
      <h1 id="deletion-title" className={styles.title}>
        {t("deletion.title")}
      </h1>
      <p>{t("deletion.webIntro")}</p>
      <p>{t("deletion.intro")}</p>
      <h2 className={styles.subtitle}>{t("deletion.removedTitle")}</h2>
      <p>{t("deletion.removed")}</p>
      <h2 className={styles.subtitle}>{t("deletion.keptTitle")}</h2>
      <p>{t("deletion.kept")}</p>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {state.step === "contact" ? <ContactStep {...props} state={state} /> : null}
      {state.step === "code" ? <CodeStep {...props} state={state} /> : null}
      {state.step === "confirm" ? <ConfirmStep {...props} state={state} /> : null}
      {state.step === "done" ? (
        <p role="status" className={styles.notice}>
          {t("deletion.done")}
        </p>
      ) : null}
    </section>
  );
}
