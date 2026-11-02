"use client";

import { teamHoldsSchema, type HoldKind, type Language, type TeamHold } from "@questify/shared";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { Card } from "#src/ui/Section.tsx";

const Holds = createContext<readonly TeamHold[]>([]);

/**
 * Reads once what Questify unpublished in the event (T-705b, FR-1414), for the notices under it. Information only: a
 * failed read shows no notice, and the database still keeps a held quest hidden.
 */
export function HoldsScope({
  organizerId,
  eventId,
  children,
}: Readonly<{ organizerId: string; eventId: string; children: ReactNode }>) {
  const [holds, setHolds] = useState<readonly TeamHold[]>([]);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/content-holds`).then(
      (result) => {
        const parsed = result.ok ? teamHoldsSchema.safeParse(result.body) : null;
        if (current && parsed?.success === true) setHolds(parsed.data.holds);
      },
    );
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return <Holds value={holds}>{children}</Holds>;
}

/** A list card that opens with the notice when Questify unpublished its item. */
export function HeldCard({
  language,
  kind,
  targetId,
  children,
}: Readonly<{ language: Language; kind: HoldKind; targetId: string; children: ReactNode }>) {
  return (
    <Card as="li">
      <HeldNotice language={language} kind={kind} targetId={targetId} />
      {children}
    </Card>
  );
}

/** "Questify unpublished this" on a held quest, reward or announcement, with the reason and Questify's note. */
export function HeldNotice({
  language,
  kind,
  targetId,
}: Readonly<{ language: Language; kind: HoldKind; targetId: string }>) {
  const t = useTranslator(language);
  const hold = useContext(Holds).find((one) => one.kind === kind && one.targetId === targetId);
  return hold === undefined ? null : (
    <Notice tone="warning" as="div">
      <p>{t("holds.notice", { reason: t(`reports.reason.${hold.reasonCode}`) })}</p>
      <p dir="auto">{hold.note}</p>
    </Notice>
  );
}
