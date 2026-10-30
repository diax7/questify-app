"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { erasedLine, holdsData, readRehearsal, type RehearsalView } from "#src/lib/rehearsal.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

type Confirming = "rotate" | "erase" | null;

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
    const read = result.ok
      ? readRehearsal((result.body as { rehearsal?: unknown } | undefined)?.rehearsal)
      : undefined;
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

  const act = async (what: "rotate" | "erase") => {
    setBusy(true);
    const result = await requestJson("POST", `${path}/${what === "rotate" ? "code" : "erase"}`);
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
    return problem === null ? null : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );
  }
  const erased = erasedLine(view);
  if (!view.open && erased === undefined) {
    return null;
  }
  const number = (value: number) => formatNumber(value, language);
  return (
    <Section titleId="rehearsal-title" title={t("rehearsal.title")}>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {erased === undefined ? null : (
        <Notice tone="success" role="status">
          {t(erased.key, erased.params)}
        </Notice>
      )}
      {view.open && view.code !== null ? (
        <>
          <p>
            <strong>{t("rehearsal.code", { code: view.code })}</strong>
          </p>
          <Muted>
            {t("rehearsal.accounts", { count: number(view.now.accounts), cap: number(view.cap) })}
          </Muted>
          {holdsData(view.now) ? (
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
          ) : null}
          {confirming === null ? (
            <Toolbar>
              <Button
                variant="secondary"

                onClick={() => void copy(view.code ?? "")}
              >
                {t("rehearsal.copy")}
              </Button>
              <Button
                variant="quiet"

                disabled={busy}
                onClick={() => setConfirming("rotate")}
              >
                {t("rehearsal.rotate")}
              </Button>
              <Button
                variant="quiet"

                disabled={busy}
                onClick={() => setConfirming("erase")}
              >
                {t("rehearsal.erase")}
              </Button>
            </Toolbar>
          ) : (
            <Dialog
              titleId="rehearsal-confirm"
              title={t(
                confirming === "rotate" ? "rehearsal.rotateConfirm" : "rehearsal.eraseConfirm",
              )}
              busy={busy}
              cancel={() => setConfirming(null)}
              actions={
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={() => void act(confirming)}>
                    {t(confirming === "rotate" ? "rehearsal.rotate" : "rehearsal.erase")}
                  </Button>
                </>
              }
            />
          )}
          {copied ? <Muted role="status">{t("rehearsal.copied")}</Muted> : null}
        </>
      ) : null}
    </Section>
  );
}
