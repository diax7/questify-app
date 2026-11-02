"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clockOf } from "#src/lib/console-organizers.ts";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Form, Input } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";

const TOKEN_IN_FRAGMENT = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/;
const API = "/v1/staff/auth/email-change";

/**
 * Reads the link's token from the URL fragment once, keeps it in memory only and removes it from the address bar, so it
 * is not left in history (as the reset page). Undefined while reading, null when the link has none.
 */
function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const taken = useRef<{ token: string | null } | null>(null);
  useEffect(() => {
    if (taken.current === null) {
      taken.current = { token: TOKEN_IN_FRAGMENT.exec(window.location.hash)?.[1] ?? null };
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setToken(taken.current.token);
  }, []);
  return token;
}

type View = Readonly<{ organizerName: string; newEmailMasked: string }>;
type Done = Readonly<{ kind: "confirmed"; email: string } | { kind: "held"; appliesAt: string }>;

/** A confirm's answer: the change applied, or held until a time; undefined for anything else. */
function doneOf(body: unknown): Done | undefined {
  const value = body as Record<string, unknown> | undefined;
  if (value?.["outcome"] === "confirmed")
    return { kind: "confirmed", email: String(value["email"]) };
  if (value?.["outcome"] === "held") return { kind: "held", appliesAt: String(value["appliesAt"]) };
  return undefined;
}

/** What the page says once the confirm went through. */
function DoneNotice({ language, done }: Readonly<{ language: Language; done: Done }>) {
  const t = translatorFor(language);
  if (done.kind === "held") {
    return (
      <Notice tone="info" role="status">
        {t("emailChange.held", { time: clockOf(done.appliesAt, language) })}
      </Notice>
    );
  }
  return (
    <>
      <Notice tone="success" role="status">
        {t("emailChange.done", { email: done.email })}
      </Notice>
      <ButtonLink variant="primary" href={`/${language}/sign-in`}>
        {t("staff.signIn")}
      </ButtonLink>
    </>
  );
}

/** The view a link opens, or null when the link is missing or no longer valid. */
async function viewOf(token: string | null): Promise<View | null> {
  if (token === null) return null;
  const result = await postJson(`${API}/view`, { token });
  const body = result.body as Record<string, unknown> | undefined;
  return result.ok && typeof body?.["organizerName"] === "string"
    ? { organizerName: body["organizerName"], newEmailMasked: String(body["newEmailMasked"]) }
    : null;
}

/** The confirm form: the code, the current password or "I don't know my password". */
function ConfirmForm({
  language,
  token,
  done,
  lost,
}: Readonly<{
  language: Language;
  token: string;
  done: (result: Done) => void;
  lost: () => void;
}>) {
  const t = translatorFor(language);
  const [noPassword, setNoPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    setBusy(true);
    const result = await postJson(`${API}/confirm`, {
      token,
      code: String(form.get("code") ?? "").trim(),
      password: noPassword ? null : password,
    });
    setBusy(false);
    const finished = result.ok ? doneOf(result.body) : undefined;
    if (finished !== undefined) {
      done(finished);
      return;
    }
    if (errorCodeOf(result.body) === "email_change_link_invalid") {
      lost();
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };
  return (
    <Form onSubmit={(event) => void submit(event)}>
      <Field label={t("emailChange.code")}>
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          dir="ltr"
          required
          pattern="[0-9]{6}"
        />
      </Field>
      {noPassword ? null : (
        <Field label={t("emailChange.password")}>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
          />
        </Field>
      )}
      <Checkbox
        label={t("emailChange.noPassword")}
        help={t("emailChange.noPasswordHelp")}
        checked={noPassword}
        onChange={(event) => setNoPassword(event.target.checked)}
      />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
        {t("emailChange.submit")}
      </Button>
    </Form>
  );
}

/**
 * Where the owner's link lands (T-701b, ADR-490): the organizer and the masked new address, then the code and the
 * current password, or a 24-hour wait without it.
 */
export function EmailChangeConfirm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const token = useFragmentToken();
  const [view, setView] = useState<View | null | undefined>(undefined);
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => {
    if (token === undefined) return;
    void viewOf(token).then(setView);
  }, [token]);
  const ready = view !== undefined && view !== null && done === null && typeof token === "string";
  return (
    <Card as="section" aria-labelledby="email-change-title">
      <PageHeader titleId="email-change-title" title={t("emailChange.title")} />
      {view === undefined ? <Muted>{t("common.loading")}</Muted> : null}
      {view === null ? (
        <Notice tone="danger" role="alert">
          {t("emailChange.noLink")}
        </Notice>
      ) : null}
      {done === null ? null : <DoneNotice language={language} done={done} />}
      {ready ? (
        <>
          <p dir="auto">
            {t("emailChange.intro", { organizer: view.organizerName, email: view.newEmailMasked })}
          </p>
          <ConfirmForm
            language={language}
            token={token}
            done={setDone}
            lost={() => setView(null)}
          />
        </>
      ) : null}
    </Card>
  );
}

/** The old address's Stop page (T-701b, ADR-491): one button; the answer says whether it stopped or told support. */
export function EmailChangeStop({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const token = useFragmentToken();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = async () => {
    if (typeof token !== "string") return;
    setBusy(true);
    const result = await postJson(`${API}/stop`, { token });
    setBusy(false);
    const body = result.body as Record<string, unknown> | undefined;
    if (result.ok && typeof body?.["outcome"] === "string") {
      setOutcome(body["outcome"]);
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };
  const said =
    outcome === "stopped"
      ? t("emailStop.stopped")
      : outcome === "reported"
        ? t("emailStop.reported")
        : t("emailStop.none");
  return (
    <Card as="section" aria-labelledby="email-stop-title">
      <PageHeader titleId="email-stop-title" title={t("emailStop.title")} />
      {token === null ? (
        <Notice tone="danger" role="alert">
          {t("emailChange.noLink")}
        </Notice>
      ) : null}
      {outcome === null ? (
        typeof token === "string" ? (
          <>
            <p dir="auto">{t("emailStop.body")}</p>
            {problem === null ? null : (
              <Notice tone="danger" role="alert">
                {problem}
              </Notice>
            )}
            <Button variant="danger" disabled={busy} aria-busy={busy} onClick={() => void stop()}>
              {t("emailStop.submit")}
            </Button>
          </>
        ) : null
      ) : (
        <Notice tone={outcome === "none" ? "info" : "success"} role="status">
          {said}
        </Notice>
      )}
    </Card>
  );
}
