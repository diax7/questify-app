"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import {
  erasedLine,
  holdsData,
  rehearsalActionPath,
  rehearsalOf,
  rehearsalWords,
  type RehearsalAction,
  type RehearsalView,
} from "#src/lib/rehearsal.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

type Confirming = "rotate" | "erase" | null;

/** The refusal or read failure of the card, in an alert; nothing while there is none. */
function RehearsalProblem({ problem }: Readonly<{ problem: string | null }>) {
  return problem === null ? null : (
    <Notice tone="danger" role="alert">
      {problem}
    </Notice>
  );
}

/** What rehearsal holds so far, with the notice that go-live erases it while it holds anything. */
function RehearsalCounts({
  language,
  view,
}: Readonly<{ language: Language; view: RehearsalView }>) {
  const t = translatorFor(language);
  const number = (value: number) => formatNumber(value, language);
  if (!holdsData(view.now)) {
    return null;
  }
  return (
    <>
      <Muted>
        {t("rehearsal.counts", {
          completions: number(view.now.completions),
          points: number(view.now.points),
          reservations: number(view.now.reservations),
        })}
      </Muted>
      <Notice tone="warning" role="status">
        {t("rehearsal.notice")}
      </Notice>
    </>
  );
}

/** The asking dialog for Change code or Erase rehearsal, and what its buttons do. */
function RehearsalConfirm({
  language,
  what,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  what: RehearsalAction;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = translatorFor(language);
  const words = rehearsalWords(what);
  return (
    <Dialog
      titleId="rehearsal-confirm"
      title={t(words.title)}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={confirm}>
            {t(words.action)}
          </Button>
        </>
      }
    />
  );
}

/** Copy code, Change code and Erase rehearsal; while one of the last two is being asked, its dialog instead. */
function RehearsalActions({
  language,
  busy,
  confirming,
  copy,
  ask,
  act,
}: Readonly<{
  language: Language;
  busy: boolean;
  confirming: Confirming;
  copy: () => void;
  ask: (what: Confirming) => void;
  act: (what: RehearsalAction) => void;
}>) {
  const t = translatorFor(language);
  if (confirming !== null) {
    return (
      <RehearsalConfirm
        language={language}
        what={confirming}
        busy={busy}
        cancel={() => ask(null)}
        confirm={() => act(confirming)}
      />
    );
  }
  return (
    <Toolbar>
      <Button variant="secondary" onClick={copy}>
        {t("rehearsal.copy")}
      </Button>
      <Button variant="quiet" disabled={busy} onClick={() => ask("rotate")}>
        {t("rehearsal.rotate")}
      </Button>
      <Button variant="quiet" disabled={busy} onClick={() => ask("erase")}>
        {t("rehearsal.erase")}
      </Button>
    </Toolbar>
  );
}

/**
 * Rehearsal (FR-1721, FR-1722; T-211): the code the team joins with in the app, how much rehearsal holds, the notice
 * that go-live erases it, and Change code and Erase rehearsal, each confirmed. After go-live: what the wipe erased.
 */
export function RehearsalCard({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const path = `/v1/organizers/${organizerId}/events/${eventId}/rehearsal`;
  const [view, setView] = useState<RehearsalView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const read = rehearsalOf(result);
    if (read === undefined) {
      setProblem(describeProblem(result.body, language, translatorFor(language)).text);
      return;
    }
    setProblem(null);
    setView(read);
  }, [path, language]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: RehearsalAction) => {
    setBusy(true);
    const result = await requestJson("POST", rehearsalActionPath(path, what));
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setCopied(false);
    await load();
  };

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  if (view === null) {
    return <RehearsalProblem problem={problem} />;
  }
  const erased = erasedLine(view);
  if (!view.open && erased === undefined) {
    return null;
  }
  const code = view.open ? view.code : null;
  return (
    <Section titleId="rehearsal-title" title={t("rehearsal.title")}>
      <RehearsalProblem problem={problem} />
      {erased === undefined ? null : (
        <Notice tone="success" role="status">
          {t(erased.key, erased.params)}
        </Notice>
      )}
      {code === null ? null : (
        <>
          <p>
            <strong>{t("rehearsal.code", { code })}</strong>
          </p>
          <Muted>
            {t("rehearsal.accounts", {
              count: formatNumber(view.now.accounts, language),
              cap: formatNumber(view.cap, language),
            })}
          </Muted>
          <RehearsalCounts language={language} view={view} />
          <RehearsalActions
            language={language}
            busy={busy}
            confirming={confirming}
            copy={() => void copy(code)}
            ask={setConfirming}
            act={(what) => void act(what)}
          />
          {copied ? <Muted role="status">{t("rehearsal.copied")}</Muted> : null}
        </>
      )}
    </Section>
  );
}
