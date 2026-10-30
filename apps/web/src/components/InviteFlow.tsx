"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CodeStep } from "#src/components/CodeStep.tsx";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { PasswordStep } from "#src/components/PasswordStep.tsx";
import { isolate, translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Form } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";

const TOKEN_IN_FRAGMENT = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/;

type Invite = Readonly<{
  organizerName: string;
  role: "editor" | "owner";
  email: string;
  accountExists: boolean;
}>;

type State =
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "no_link"; message: string | null }>
  | Readonly<{ kind: "ready"; token: string; invite: Invite }>
  | Readonly<{ kind: "code"; token: string; invite: Invite; challengeToken: string }>;

const isInvite = (value: unknown): value is Invite =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)["organizerName"] === "string" &&
  typeof (value as Record<string, unknown>)["email"] === "string";

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
  const [state, setState] = useState<State>({ kind: "reading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const taken = useRef<{ token: string | undefined } | null>(null);

  // Runs once per page: the link is inspected a single time (a second look would count against the address limit, and
  // after acceptance would answer "used" and wipe the code step).
  useEffect(() => {
    if (taken.current !== null) {
      return;
    }
    taken.current = { token: TOKEN_IN_FRAGMENT.exec(window.location.hash)?.[1] };
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const { token } = taken.current;
    if (token === undefined) {
      setState({ kind: "no_link", message: null });
      return;
    }
    void postJson("/v1/staff/invites/inspect", { token }).then((result) => {
      setState(
        result.ok && isInvite(result.body)
          ? { kind: "ready", token, invite: result.body }
          : {
              kind: "no_link",
              message: describeProblem(result.body, language, translatorFor(language)).text,
            },
      );
    });
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
    const body = result.body as { challengeToken?: unknown } | undefined;
    if (result.ok && typeof body?.challengeToken === "string") {
      setState({ kind: "code", token, invite, challengeToken: body.challengeToken });
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  if (state.kind === "reading") {
    return <Muted>{t("common.loading")}</Muted>;
  }
  if (state.kind === "no_link") {
    return (
      <Stack as="section">
        <Notice tone="danger" role="alert">
          {state.message ?? t("staff.inviteMissing")}
        </Notice>
      </Stack>
    );
  }
  const { invite, token } = state;
  const heading = t(invite.role === "owner" ? "staff.invitedOwner" : "staff.invitedEditor", {
    name: invite.organizerName,
  });
  const alert =
    problem === null ? null : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );

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
    <Stack as="section" aria-labelledby="invite-title">
      <PageHeader titleId="invite-title" title={t("staff.inviteTitle")} />
      <p>{heading}</p>
      <Muted>{t("staff.inviteFor", { email: isolate(invite.email) })}</Muted>
      {alert}
      {signedInEmail !== null && signedInEmail === invite.email ? (
        <Button
          variant="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void accept(token)}
        >
          {t("staff.acceptInvite")}
        </Button>
      ) : null}
      {signedInEmail !== null && signedInEmail !== invite.email ? (
        <Notice tone="info">{t("staff.inviteOtherSignedIn")}</Notice>
      ) : null}
      {signedInEmail === null && invite.accountExists ? (
        <InlineSignIn language={language} onSignedIn={() => accept(token)} />
      ) : null}
      {signedInEmail === null && !invite.accountExists ? (
        <Form onSubmit={(event) => void join(event, token, invite)}>
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
      ) : null}
    </Stack>
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
