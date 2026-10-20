"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Member = Readonly<{
  staffUserId: string;
  email: string;
  role: "owner" | "editor";
  eventScope: readonly string[] | null;
}>;
type PendingInvite = Readonly<{ id: string; email: string; role: "owner" | "editor" }>;
type TeamView = Readonly<{ members: readonly Member[]; invites: readonly PendingInvite[] }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * An organizer's team (FR-1011–1013, FR-1723, FR-1724). Everyone sees the list; only the owner sees the controls, and
 * the API refuses an editor every change anyway. Event limits can be set once events exist (T-102).
 */
export function TeamPanel({
  language,
  organizerId,
  myRole,
}: Readonly<{ language: Language; organizerId: string; myRole: "owner" | "editor" }>) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}`;
  const [team, setTeam] = useState<TeamView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await requestJson("GET", `${base}/members`);
    if (result.ok) {
      setTeam(result.body as TeamView);
    } else {
      setProblem(describeProblem(result.body, language, t).text);
    }
  }, [base, language, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
    done?: string,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson(method, `${base}${path}`, payload);
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return false;
    }
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return false;
    }
    if (done !== undefined) {
      setNotice(done);
    }
    await load();
    return true;
  };

  const sendInvite = async (event: FormEvent<HTMLFormElement>, path: "/invites" | "/ownership") => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "").trim();
    if (await act("POST", path, { email, lang: language }, t("staff.inviteSent"))) {
      form.reset();
    }
  };

  const leave = async () => {
    if (await act("DELETE", "/members/me")) {
      window.location.assign(`/${language}`);
    }
  };

  const isOwner = myRole === "owner";
  return (
    <section className={styles.panel} aria-labelledby="team-title">
      <h1 id="team-title" className={styles.title}>
        {t("staff.team")}
      </h1>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <h2 className={styles.subtitle}>{t("staff.members")}</h2>
      {team === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : (
        <ul className={styles.list}>
          {team.members.map((member) => (
            <li key={member.staffUserId} className={styles.card}>
              <span dir="ltr">{member.email}</span>
              <span className={styles.badge}>
                {t(`staff.role.${member.role}`)}
                {member.role === "editor"
                  ? ` · ${member.eventScope === null ? t("staff.allEvents") : t("staff.chosenEvents")}`
                  : ""}
              </span>
              {isOwner && member.role === "editor" ? (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy}
                  onClick={() => void act("DELETE", `/members/${member.staffUserId}`)}
                >
                  {t("staff.remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isOwner ? (
        <>
          <h2 className={styles.subtitle}>{t("staff.pendingInvites")}</h2>
          {team === null || team.invites.length === 0 ? (
            <p className={styles.muted}>{t("staff.noPendingInvites")}</p>
          ) : (
            <ul className={styles.list}>
              {team.invites.map((invite) => (
                <li key={invite.id} className={styles.card}>
                  <span dir="ltr">{invite.email}</span>
                  <span className={styles.badge}>{t(`staff.role.${invite.role}`)}</span>
                  <button
                    type="button"
                    className={styles.quiet}
                    disabled={busy}
                    onClick={() => void act("DELETE", `/invites/${invite.id}`)}
                  >
                    {t("staff.cancelInvite")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <InviteForm
            language={language}
            busy={busy}
            title="staff.inviteEditor"
            hint="staff.inviteEditorHint"
            action="staff.sendInvite"
            onSubmit={(event) => void sendInvite(event, "/invites")}
          />
          <InviteForm
            language={language}
            busy={busy}
            title="staff.transferTitle"
            hint="staff.transferHint"
            action="staff.sendOwnerInvite"
            onSubmit={(event) => void sendInvite(event, "/ownership")}
          />
        </>
      ) : (
        <button type="button" className={styles.quiet} disabled={busy} onClick={() => void leave()}>
          {t("staff.leave")}
        </button>
      )}
    </section>
  );
}

function InviteForm({
  language,
  busy,
  title,
  hint,
  action,
  onSubmit,
}: Readonly<{
  language: Language;
  busy: boolean;
  title: "staff.inviteEditor" | "staff.transferTitle";
  hint: "staff.inviteEditorHint" | "staff.transferHint";
  action: "staff.sendInvite" | "staff.sendOwnerInvite";
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const t = translatorFor(language);
  const id = `${title.replace(".", "-")}-heading`;
  return (
    <form className={styles.form} onSubmit={onSubmit} aria-labelledby={id}>
      <h2 id={id} className={styles.subtitle}>
        {t(title)}
      </h2>
      <p className={styles.muted}>{t(hint)}</p>
      <label className={styles.field}>
        <span>{t("staff.email")}</span>
        <input
          className={styles.input}
          name="email"
          type="email"
          dir="ltr"
          autoComplete="off"
          required
          disabled={busy}
        />
      </label>
      <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
        {t(action)}
      </button>
    </form>
  );
}
