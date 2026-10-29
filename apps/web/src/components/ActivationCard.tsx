"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import {
  addonName,
  limitBanner,
  limitLine,
  readActivation,
  type ActivationView,
} from "#src/lib/activation.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Where the event stands with Questify (FR-1019, FR-1020, FR-1021, FR-1729): the owner requests or withdraws
 * activation; once activated, the limit, the 80% and 100% banners, and the add-ons. No price appears anywhere.
 */
export function ActivationCard({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const path = `/v1/organizers/${organizerId}/events/${eventId}/activation`;
  const [view, setView] = useState<ActivationView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const read = result.ok
      ? readActivation((result.body as { activation?: unknown } | undefined)?.activation)
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

  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    const result = await requestJson(method, path);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    await load();
  };

  if (view === null) {
    return problem === null ? null : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );
  }
  const banner = limitBanner(view);
  const limit = limitLine(view);
  return (
    <Section titleId="activation-title" title={t("activation.title")}>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {banner === undefined ? null : (
        <Notice tone="warning" role="status">
          {t(banner.key, banner.params)}
        </Notice>
      )}
      {view.state === "activated" ? (
        <>
          <p>{t(limit.key, limit.params)}</p>
          <Muted>{t("activation.players", { count: view.players })}</Muted>
          <Muted>
            {view.addons.length === 0
              ? t("activation.noAddons")
              : t("activation.addons", {
                  list: view.addons.map((feature) => addonName(feature, t)).join("، "),
                })}
          </Muted>
        </>
      ) : (
        <DraftActions
          language={language}
          view={view}
          isOwner={myRole === "owner"}
          busy={busy}
          confirming={confirming}
          setConfirming={setConfirming}
          act={(method) => void act(method)}
        />
      )}
    </Section>
  );
}

/** A draft's lines and buttons: request (owner), the request's date and withdraw, or the rejection note. */
function DraftActions({
  language,
  view,
  isOwner,
  busy,
  confirming,
  setConfirming,
  act,
}: Readonly<{
  language: Language;
  view: ActivationView;
  isOwner: boolean;
  busy: boolean;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  act: (method: "POST" | "DELETE") => void;
}>) {
  const t = translatorFor(language);
  if (confirming) {
    return (
      <Dialog
        titleId="withdraw-title"
        title={t("activation.withdrawConfirm")}
        busy={busy}
        cancel={() => setConfirming(false)}
        actions={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => act("DELETE")}>
              {t("activation.withdraw")}
            </Button>
          </>
        }
      />
    );
  }
  return (
    <>
      <p>{t("activation.notActivated")}</p>
      {view.state === "requested" && view.requestedAt !== null ? (
        <Notice tone="success" role="status">
          {t("activation.requested", {
            date: formatEventTime(new Date(view.requestedAt), readerZone(), language),
          })}
        </Notice>
      ) : null}
      {view.state === "rejected" && view.note !== null ? (
        <Notice tone="danger">{t("activation.rejected", { note: view.note })}</Notice>
      ) : null}
      {isOwner ? (
        <Toolbar>
          {view.state === "requested" ? (
            <Button
              variant="quiet"

              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t("activation.withdraw")}
            </Button>
          ) : (
            <Button
              variant="secondary"

              disabled={busy}
              onClick={() => act("POST")}
            >
              {t(view.state === "rejected" ? "activation.requestAgain" : "activation.request")}
            </Button>
          )}
        </Toolbar>
      ) : (
        <Muted>{t("activation.editorHint")}</Muted>
      )}
      <Muted>{t("activation.priceNote")}</Muted>
    </>
  );
}
