"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clockOf } from "#src/lib/console-organizers.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Row, Rows, Section, Toolbar } from "#src/ui/Section.tsx";

type StaffSession = Readonly<{
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}>;

/** What to end: one other session, or all of them. */
type Ending = Readonly<{ kind: "one"; id: string }> | Readonly<{ kind: "others" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The sessions of `GET /v1/staff/sessions`, or undefined when the body is not that shape. */
export function readStaffSessions(body: unknown): StaffSession[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["sessions"])) return undefined;
  return body["sessions"].flatMap((row: unknown) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["createdAt"] === "string" &&
    typeof row["lastSeenAt"] === "string" &&
    typeof row["current"] === "boolean"
      ? [
          {
            id: row["id"],
            createdAt: row["createdAt"],
            lastSeenAt: row["lastSeenAt"],
            userAgent: typeof row["userAgent"] === "string" ? row["userAgent"] : null,
            ip: typeof row["ip"] === "string" ? row["ip"] : null,
            current: row["current"],
          },
        ]
      : [],
  );
}

const key = () => ({ "idempotency-key": crypto.randomUUID() });

const endRequest = (ending: Ending): Promise<PostResult> =>
  ending.kind === "one"
    ? requestJson("DELETE", `/v1/staff/sessions/${ending.id}`)
    : requestJson("POST", "/v1/staff/sessions/end-others", {}, key());

/**
 * The emailed code that makes this session fresh (T-810c, ASVS V7.5.2), then the end it was asked for, once.
 */
function ReauthDialog({
  language,
  ending,
  cancel,
  ended,
}: Readonly<{
  language: Language;
  ending: Ending;
  cancel: () => void;
  ended: (result: PostResult) => void;
}>) {
  const t = translatorFor(language);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    const result = await requestJson("POST", "/v1/staff/reauth/code", {});
    setBusy(false);
    if (result.ok && isRecord(result.body) && typeof result.body["challengeToken"] === "string") {
      setToken(result.body["challengeToken"]);
      setProblem(null);
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };
  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    const result = await requestJson(
      "POST",
      "/v1/staff/reauth/verify",
      { challengeToken: token, code },
      key(),
    );
    if (!result.ok) {
      setBusy(false);
      if (errorCodeOf(result.body) === "challenge_expired") setToken(null);
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    ended(await endRequest(ending));
  };
  return (
    <Dialog
      title={t("staff.reauth.title")}
      role="dialog"
      cancel={cancel}
      busy={busy}
      actions={
        <Button variant="quiet" onClick={cancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
      }
    >
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {token === null ? (
        <>
          <p>{t("staff.reauth.body")}</p>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            {t("staff.reauth.send")}
          </Button>
        </>
      ) : (
        <Form onSubmit={(event) => void confirm(event)}>
          <p>{t("staff.reauth.sent")}</p>
          <Field label={t("staff.reauth.code")}>
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              dir="ltr"
              required
            />
          </Field>
          <Toolbar>
            <Button type="submit" variant="primary" disabled={busy}>
              {t("staff.reauth.confirm")}
            </Button>
          </Toolbar>
        </Form>
      )}
    </Dialog>
  );
}

function Notices({ notice, problem }: Readonly<{ notice: string | null; problem: string | null }>) {
  return (
    <>
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </>
  );
}

/** Each session with its start and last activity; "End" on every one but this, and "End all other sessions". */
function SessionRows({
  language,
  sessions,
  end,
}: Readonly<{ language: Language; sessions: StaffSession[]; end: (ending: Ending) => void }>) {
  const t = translatorFor(language);
  const others = sessions.filter((session) => !session.current);
  return (
    <>
      <Rows>
        {sessions.map((session) => (
          <Row
            key={session.id}
            main={
              <span data-testid="staff-session">
                <bdi dir="ltr">{session.userAgent ?? "-"}</bdi>{" "}
                {session.current ? <Badge tone="info">{t("staff.sessions.current")}</Badge> : null}
                <Muted as="span">
                  {" "}
                  {t("staff.sessions.started", { time: clockOf(session.createdAt, language) })}
                  {" · "}
                  {t("staff.sessions.lastSeen", { time: clockOf(session.lastSeenAt, language) })}
                </Muted>
              </span>
            }
          >
            {session.current ? null : (
              <Button
                size="sm"
                variant="danger"
                onClick={() => end({ kind: "one", id: session.id })}
              >
                {t("staff.sessions.end")}
              </Button>
            )}
          </Row>
        ))}
      </Rows>
      {others.length === 0 ? (
        <Muted>{t("staff.sessions.onlyThis")}</Muted>
      ) : (
        <Toolbar>
          <Button variant="danger" onClick={() => end({ kind: "others" })}>
            {t("staff.sessions.endOthers")}
          </Button>
        </Toolbar>
      )}
    </>
  );
}

/**
 * The signed-in person's own sessions (T-810c, FR-1785, ASVS V7.5.2): each browser with its start and last activity,
 * "End" on another one and "End all other sessions". Ending another session asks for an emailed code first unless
 * this session signed in or confirmed a code in the last 10 minutes; the database checks it, not only this page.
 */
export function StaffSessions({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [sessions, setSessions] = useState<StaffSession[] | null | "failed">(null);
  const [asking, setAsking] = useState<Ending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await requestJson("GET", "/v1/staff/sessions");
    setSessions((result.ok ? readStaffSessions(result.body) : undefined) ?? "failed");
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const settle = (ending: Ending, result: PostResult) => {
    setAsking(null);
    if (result.ok) {
      setProblem(null);
      setNotice(t(ending.kind === "one" ? "staff.sessions.ended" : "staff.sessions.endedOthers"));
    } else if (errorCodeOf(result.body) === "reauth_required") {
      setAsking(ending);
      return;
    } else {
      setProblem(describeProblem(result.body, language, t).text);
    }
    void load();
  };
  const end = async (ending: Ending) => settle(ending, await endRequest(ending));

  return (
    <Section title={t("staff.sessions.title")} titleId="staff-sessions-title">
      <Notices notice={notice} problem={problem} />
      {sessions === null ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {sessions === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("staff.sessions.loadFailed")}{" "}
          <Button size="sm" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {Array.isArray(sessions) ? (
        <SessionRows language={language} sessions={sessions} end={(ending) => void end(ending)} />
      ) : null}
      {asking === null ? null : (
        <ReauthDialog
          language={language}
          ending={asking}
          cancel={() => setAsking(null)}
          ended={(result) => settle(asking, result)}
        />
      )}
    </Section>
  );
}
