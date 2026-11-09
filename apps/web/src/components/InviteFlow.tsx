"use client";

import type { Language } from "@questify/shared";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { CodeStep } from "#src/components/CodeStep.tsx";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { PasswordStep } from "#src/components/PasswordStep.tsx";
import {
  challengeOf,
  inspectedState,
  inviteModeOf,
  tokenFromHash,
  type Invite,
  type InviteState,
} from "#src/lib/invite-link.ts";
import { isolate, translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Form } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";

/** The page of a link that is missing or no longer works: the title, then why. */
function MissingLink({
  language,
  message,
}: Readonly<{ language: Language; message: string | null }>) {
  const t = translatorFor(language);
  return (
    <Stack as="section" aria-labelledby="invite-title">
      <PageHeader titleId="invite-title" title={t("staff.inviteTitle")} />
      <Notice tone="danger" role="alert">
        {message ?? t("staff.inviteMissing")}
      </Notice>
    </Stack>
  );
}

/**
 * Inspects the link once per page: the token is taken from the URL fragment, which is then cleared. A second look would
 * count against the address limit, and after acceptance would answer "used" and wipe the code step.
 */
function inspectLink(
  taken: { current: { token: string | undefined } | null },
  language: Language,
  setState: Dispatch<SetStateAction<InviteState>>,
) {
  if (taken.current !== null) {
    return;
  }
  taken.current = { token: tokenFromHash(window.location.hash) };
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  const { token } = taken.current;
  if (token === undefined) {
    setState({ kind: "no_link", message: null });
    return;
  }
  void postJson("/v1/staff/invites/inspect", { token }).then((result) => {
    setState(
      inspectedState(
        result,
        token,
        (body) => describeProblem(body, language, translatorFor(language)).text,
      ),
    );
  });
}

/** What the invite page offers its reader: accept, a note, sign in here, or choose a password. */
function InviteActions({
  language,
  signedInEmail,
  invite,
  busy,
  accept,
  join,
}: Readonly<{
  language: Language;
  signedInEmail: string | null;
  invite: Invite;
  busy: boolean;
  accept: () => Promise<void>;
  join: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const t = translatorFor(language);
  switch (inviteModeOf(signedInEmail, invite)) {
    case "accept":
      return (
        <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void accept()}>
          {t("staff.acceptInvite")}
        </Button>
      );
    case "otherSignedIn":
      return <Notice tone="info">{t("staff.inviteOtherSignedIn")}</Notice>;
    case "signIn":
      return <InlineSignIn language={language} onSignedIn={accept} />;
    case "join":
      return (
        <Form onSubmit={join}>
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={invite.email}
            readOnly
            hidden
          />
          <NewPasswordFields language={language} disabled={busy} />
          <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
            {t("staff.acceptInvite")}
          </Button>
        </Form>
      );
  }
}

/** The invite itself: who invited, for which email, any refusal, then what the reader can do about it. */
function InviteDetails({
  language,
  signedInEmail,
  invite,
  problem,
  busy,
  accept,
  join,
}: Readonly<{
  language: Language;
  signedInEmail: string | null;
  invite: Invite;
  problem: string | null;
  busy: boolean;
  accept: () => Promise<void>;
  join: (event: FormEvent<HTMLFormElement>) => void;
}>) {
  const t = translatorFor(language);
  const heading = t(invite.role === "owner" ? "staff.invitedOwner" : "staff.invitedEditor", {
    name: invite.organizerName,
  });
  const alert =
    problem === null ? null : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );
  return (
    <Stack as="section" aria-labelledby="invite-title">
      <PageHeader titleId="invite-title" title={t("staff.inviteTitle")} />
      <p>{heading}</p>
      <Muted>{t("staff.inviteFor", { email: isolate(invite.email) })}</Muted>
      {alert}
      <InviteActions
        language={language}
        signedInEmail={signedInEmail}
        invite={invite}
        busy={busy}
        accept={accept}
        join={join}
      />
    </Stack>
  );
}

/**
 * Where an invite link lands. The token is read from the URL fragment once and kept in memory only (as on the reset
 * page). Someone new chooses a password and enters the emailed sign-in code; someone with an account signs in here and
 * accepts, without leaving the page; someone already signed in with that email accepts at once.
 */
export function InviteFlow({
  language,
  signedInEmail,
}: Readonly<{ language: Language; signedInEmail: string | null }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<InviteState>({ kind: "reading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const taken = useRef<{ token: string | undefined } | null>(null);

  // Runs once per page: the link is inspected a single time.
  useEffect(() => {
    inspectLink(taken, language, setState);
  }, [language]);

  const accept = async (token: string): Promise<void> => {
    setBusy(true);
    const result = await postJson("/v1/staff/invites/accept", { token });
    if (result.ok) {
      window.location.assign(`/${language}`);
      return;
    }
    setBusy(false);
    setProblem(describeProblem(result.body, language, t).text);
  };

  const join = async (event: FormEvent<HTMLFormElement>, token: string, invite: Invite) => {
    event.preventDefault();
    const password = readNewPassword(new FormData(event.currentTarget));
    if (password === undefined) {
      setProblem(t("staff.passwordsDiffer"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await postJson("/v1/staff/invites/accept-new", { token, password });
    setBusy(false);
    const challengeToken = challengeOf(result);
    if (challengeToken !== undefined) {
      setState({ kind: "code", token, invite, challengeToken });
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  if (state.kind === "reading") {
    return <Muted>{t("common.loading")}</Muted>;
  }
  if (state.kind === "no_link") {
    return <MissingLink language={language} message={state.message} />;
  }
  const { invite, token } = state;
  if (state.kind === "code") {
    return (
      <Stack as="section" aria-labelledby="sign-in-title">
        <CodeStep
          language={language}
          email={invite.email}
          challengeToken={state.challengeToken}
          onRestart={(reason) =>
            setState({ kind: "no_link", message: reason === "" ? null : reason })
          }
        />
      </Stack>
    );
  }
  return (
    <InviteDetails
      language={language}
      signedInEmail={signedInEmail}
      invite={invite}
      problem={problem}
      busy={busy}
      accept={() => accept(token)}
      join={(event) => void join(event, token, invite)}
    />
  );
}

/** Sign-in inside the invite page, so the token in memory survives; then the invite is accepted. */
function InlineSignIn({
  language,
  onSignedIn,
}: Readonly<{ language: Language; onSignedIn: () => Promise<void> }>) {
  const t = translatorFor(language);
  const [challenge, setChallenge] = useState<{ email: string; token: string } | null>(null);
  return (
    <>
      <Muted>{t("staff.signInToAccept")}</Muted>
      {challenge === null ? (
        <PasswordStep
          language={language}
          onCodeSent={(email, token) => setChallenge({ email, token })}
        />
      ) : (
        <CodeStep
          language={language}
          email={challenge.email}
          challengeToken={challenge.token}
          onRestart={() => setChallenge(null)}
          onSignedIn={onSignedIn}
        />
      )}
    </>
  );
}
