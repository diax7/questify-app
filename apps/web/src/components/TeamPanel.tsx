"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { infoTip } from "#src/ui/info.tsx";

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
    <Stack as="section" aria-labelledby="team-title">
      <PageHeader titleId="team-title" title={t("staff.team")} />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      <MembersSection
        language={language}
        team={team}
        isOwner={isOwner}
        busy={busy}
        remove={(id) => void act("DELETE", `/members/${id}`)}
      />
      {isOwner ? (
        <>
          <InvitesSection
            language={language}
            team={team}
            busy={busy}
            cancel={(id) => void act("DELETE", `/invites/${id}`)}
          />
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
        <Toolbar>
          <Button variant="danger" disabled={busy} onClick={() => void leave()}>
            {t("staff.leave")}
          </Button>
        </Toolbar>
      )}
    </Stack>
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
    <Section titleId={id} title={t(title)} info={infoTip(t, hint)}>
      <Form onSubmit={onSubmit} aria-labelledby={id}>
        <Field label={t("staff.email")}>
          <Input name="email" type="email" dir="ltr" autoComplete="off" required disabled={busy} />
        </Field>
        <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
          {t(action)}
        </Button>
      </Form>
    </Section>
  );
}

/** Who is on the team, with their role; the owner can remove an editor. */
function MembersSection({
  language,
  team,
  isOwner,
  busy,
  remove,
}: Readonly<{
  language: Language;
  team: TeamView | null;
  isOwner: boolean;
  busy: boolean;
  remove: (staffUserId: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Section title={t("staff.members")}>
      {team === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : (
        <Rows>
          {team.members.map((member) => (
            <Row
              key={member.staffUserId}
              main={
                <>
                  <span dir="ltr">{member.email}</span>
                  <Badge>
                    {t(`staff.role.${member.role}`)}
                    {member.role === "editor"
                      ? ` · ${member.eventScope === null ? t("staff.allEvents") : t("staff.chosenEvents")}`
                      : ""}
                  </Badge>
                </>
              }
            >
              {isOwner && member.role === "editor" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => remove(member.staffUserId)}
                >
                  {t("staff.remove")}
                </Button>
              ) : null}
            </Row>
          ))}
        </Rows>
      )}
    </Section>
  );
}

/** Invites sent and not yet accepted, each with Cancel. */
function InvitesSection({
  language,
  team,
  busy,
  cancel,
}: Readonly<{
  language: Language;
  team: TeamView | null;
  busy: boolean;
  cancel: (inviteId: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Section title={t("staff.pendingInvites")}>
      {team === null || team.invites.length === 0 ? (
        <EmptyState>{t("staff.noPendingInvites")}</EmptyState>
      ) : (
        <Rows>
          {team.invites.map((invite) => (
            <Row
              key={invite.id}
              main={
                <>
                  <span dir="ltr">{invite.email}</span>
                  <Badge>{t(`staff.role.${invite.role}`)}</Badge>
                </>
              }
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => cancel(invite.id)}
              >
                {t("staff.cancelInvite")}
              </Button>
            </Row>
          ))}
        </Rows>
      )}
    </Section>
  );
}
