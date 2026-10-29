"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Row, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** An event switch a player feature has (FR-219, FR-1009): its route and its words. */
const FEATURES = {
  shareQuests: {
    path: "share-quests",
    title: "events.shareQuests.title",
    label: "events.shareQuests.label",
    on: "events.shareQuests.on",
    off: "events.shareQuests.off",
  },
  meetSomeone: {
    path: "meet-someone",
    title: "events.meetSomeone.title",
    label: "events.meetSomeone.label",
    on: "events.meetSomeone.on",
    off: "events.meetSomeone.off",
  },
  miniGames: {
    path: "mini-games",
    title: "events.miniGames.title",
    label: "events.miniGames.label",
    on: "events.miniGames.on",
    off: "events.miniGames.off",
  },
  community: {
    path: "community",
    title: "events.community.title",
    label: "events.community.label",
    on: "events.community.on",
    off: "events.community.off",
  },
  flashQuests: {
    path: "flash-quests",
    title: "events.flashQuests.title",
    label: "events.flashQuests.label",
    on: "events.flashQuests.on",
    off: "events.flashQuests.off",
  },
  boosts: {
    path: "double-points",
    title: "events.boosts.title",
    label: "events.boosts.label",
    on: "events.boosts.on",
    off: "events.boosts.off",
  },
  helpDesk: {
    path: "help-desk",
    title: "events.helpDesk.title",
    label: "events.helpDesk.label",
    on: "events.helpDesk.on",
    off: "events.helpDesk.off",
  },
} as const satisfies Record<
  string,
  Readonly<{ path: string; title: MessageKey; label: MessageKey; on: MessageKey; off: MessageKey }>
>;

type Props = Readonly<{
  language: Language;
  feature: keyof typeof FEATURES;
  organizerId: string;
  eventId: string;
  /** The event's switch as the page last read it. */
  initial: boolean;
  myRole: "owner" | "editor";
}>;

/**
 * An event's share quests, meet-someone, mini-games or community quests switch (FR-219, ADR-199; FR-1009, ADR-210,
 * ADR-213; T-306b, ADR-226): on by default; off hides every quest of that type from players and stops paying them (off
 * for community quests finishes a running goal, whose reached steps still pay, and warns that what it would unlock stays
 * locked, T-306c). Flash quests and double points (T-307) work the same way: off hides every flash quest, or stops
 * every boost paying, at once. The help desk (T-310) off stops new requests while open ones stay answerable. The owner changes it; an editor sees which it is. Saved as soon as the box changes.
 */
export function EventFeatureSwitch({
  language,
  feature,
  organizerId,
  eventId,
  initial,
  myRole,
}: Props) {
  const t = useTranslator(language);
  const words = FEATURES[feature];
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (enabled: boolean) => {
    const before = on;
    setOn(enabled);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/${words.path}`,
      { enabled },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setOn(before);
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setOn((result.body as Record<string, unknown>)[feature] === true);
  };

  return (
    <Row
      as="section"
      aria-labelledby={`${words.path}-title`}
      main={
        <>
          <SubHeading id={`${words.path}-title`}>{t(words.title)}</SubHeading>
          <Muted role="status">
            {t(on ? words.on : words.off)}{" "}
            {myRole === "owner" ? null : t("events.ranking.ownerOnly")}
          </Muted>
          {myRole === "owner" && on && feature === "community" ? (
            <Muted>{t("events.community.offWarning")}</Muted>
          ) : null}
          {myRole === "owner" ? (
            <Switch
              label={t(words.label)}
              checked={on}
              disabled={busy}
              onChange={(changed) => void save(changed.target.checked)}
            />
          ) : null}
          {problem === null ? null : (
            <Notice role="alert" tone="danger">
              {problem}
            </Notice>
          )}
        </>
      }
    />
  );
}
