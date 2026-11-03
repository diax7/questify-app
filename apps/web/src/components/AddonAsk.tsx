"use client";

import { formatEventTime, type FeatureRequestState, type Language } from "@questify/shared";
import { useState } from "react";
import { askButtonOf, askState, type AskState } from "#src/lib/event-layers.ts";
import type { Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Props = Readonly<{
  t: Translate;
  language: Language;
  feature: string;
  /** The owner's latest request for this add-on, as the features list read it. */
  request: FeatureRequestState | null;
  /** Where the request is sent; absent for an editor, who sees the state but cannot ask (Q-502). */
  target?: Readonly<{ organizerId: string; eventId: string }> | undefined;
}>;

/**
 * A locked add-on's Ask Questify (T-711b, FR-1827): the owner asks once and the card says Requested; a declined request
 * says Not approved, with Ask again after 24 hours. The Contact page stays as a second way to reach Questify.
 */
export function AddonAsk({ t, language, feature, request, target }: Props) {
  const [current, setCurrent] = useState(request);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const state = askState(current, Date.now());

  const ask = async () => {
    if (target === undefined || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      `/v1/organizers/${target.organizerId}/events/${target.eventId}/feature-requests`,
      { feature },
    );
    setBusy(false);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setCurrent({ status: "open", at: new Date().toISOString() });
  };

  const label = target === undefined ? null : askButtonOf(state);

  return (
    <>
      <AskStatus t={t} language={language} state={state} />
      {label === null ? null : (
        <Button variant="secondary" aria-busy={busy} onClick={() => void ask()}>
          {t(label === "ask" ? "wizard.addon.ask" : "wizard.addon.askAgain")}
        </Button>
      )}
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      <TextLink href={`/${language}/contact`}>{t("wizard.addon.contact")}</TextLink>
    </>
  );
}

/** Requested, or Not approved with when the owner may ask again; nothing before the first request. */
function AskStatus({
  t,
  language,
  state,
}: Readonly<{ t: Translate; language: Language; state: AskState }>) {
  if (state.kind === "requested") {
    return <Badge tone="info">{t("wizard.addon.requested")}</Badge>;
  }
  if (state.kind !== "declined") {
    return null;
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <>
      <Badge tone="warning">{t("wizard.addon.declined")}</Badge>
      {state.askAgainAt === null ? null : (
        <Muted>
          {t("wizard.addon.askAgainAt", {
            date: formatEventTime(new Date(state.askAgainAt), zone, language),
          })}
        </Muted>
      )}
    </>
  );
}
