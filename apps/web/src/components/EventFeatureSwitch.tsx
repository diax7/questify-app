"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useState } from "react";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Row, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** How many prizes players still hold in the event, or null when the count could not be read (T-602d). */
async function countHeldPrizes(organizerId: string, eventId: string): Promise<number | null> {
  const counted = await requestJson(
    "GET",
    `/v1/organizers/${organizerId}/events/${eventId}/held-prizes`,
  );
  const held = (counted.body as Record<string, unknown> | undefined)?.["held"];
  return counted.ok && typeof held === "number" ? held : null;
}

/** After the shop is turned off: how many prizes players still hold, or that the count failed. */
function HeldNotice({
  language,
  held,
}: Readonly<{ language: Language; held: Readonly<{ count: number | null }> | undefined }>) {
  const t = useTranslator(language);
  if (held === undefined) {
    return null;
  }
  return held.count === null ? (
    <Notice role="alert" tone="warning">
      {t("events.shop.heldFailed")}
    </Notice>
  ) : (
    <Notice role="status" tone="info">
      {t("events.shop.heldAfterOff", { count: held.count })}
    </Notice>
  );
}

/** An event switch a player feature has (FR-219, FR-1009): its route and its words. */
const FEATURES = {
  shareQuests: {
    path: "share-quests",
    title: "events.shareQuests.title",
    label: "events.shareQuests.label",
  },
  meetSomeone: {
    path: "meet-someone",
    title: "events.meetSomeone.title",
    label: "events.meetSomeone.label",
  },
  miniGames: {
    path: "mini-games",
    title: "events.miniGames.title",
    label: "events.miniGames.label",
  },
  community: {
    path: "community",
    title: "events.community.title",
    label: "events.community.label",
  },
  flashQuests: {
    path: "flash-quests",
    title: "events.flashQuests.title",
    label: "events.flashQuests.label",
  },
  boosts: {
    path: "double-points",
    title: "events.boosts.title",
    label: "events.boosts.label",
  },
  helpDesk: {
    path: "help-desk",
    title: "events.helpDesk.title",
    label: "events.helpDesk.label",
  },
  questRatings: {
    path: "quest-ratings",
    title: "events.questRatings.title",
    label: "events.questRatings.label",
  },
  cheers: {
    path: "cheers",
    title: "events.cheers.title",
    label: "events.cheers.label",
  },
  shop: {
    path: "features/shop",
    title: "events.shop.title",
    label: "events.shop.label",
  },
  polls: {
    path: "features/polls",
    title: "events.polls.title",
    label: "events.polls.label",
  },
  maps: {
    path: "features/maps",
    title: "events.maps.title",
    label: "events.maps.label",
  },
  agenda: {
    path: "features/agenda",
    title: "events.agenda.title",
    label: "events.agenda.label",
  },
} as const satisfies Record<
  string,
  Readonly<{ path: string; title: MessageKey; label: MessageKey }>
>;

type Props = Readonly<{
  language: Language;
  feature: keyof typeof FEATURES;
  organizerId: string;
  eventId: string;
  /** The event's switch as the page last read it. */
  initial: boolean;
  myRole: "owner" | "editor";
  /** The event is live: turning a switch off then asks first (FR-1031), since players lose the feature at once. */
  live?: boolean;
  /** Told the switch's saved value, for a page that shows more than the switch (the Big screen page's Cheers, T-509). */
  onSaved?: (enabled: boolean) => void;
}>;

/**
 * An event's share quests, meet-someone, mini-games or community quests switch (FR-219, ADR-199; FR-1009, ADR-210,
 * ADR-213; T-306b, ADR-226): on by default; off hides every quest of that type from players and stops paying them (off
 * for community quests finishes a running goal, whose reached steps still pay, and warns that what it would unlock stays
 * locked, T-306c). Flash quests and double points (T-307) work the same way: off hides every flash quest, or stops
 * every boost paying, at once. The help desk (T-310) off stops new requests while open ones stay answerable. Quest
 * ratings (T-508) are the one switch that starts off: players are asked only after the owner turns it on. Cheers
 * (T-509) sits on the Big screen page: off ends any live cheers moment. The shop, live polls, maps and agenda (T-602,
 * FR-1009) take their screens off the player's side, and nothing the team has built; turning the shop off says how
 * many prizes players still hold, which they collect from Home (T-602d). The owner
 * changes it; an editor sees it switched and cannot change it. Saved as soon as the box changes.
 */
export function EventFeatureSwitch({
  language,
  feature,
  organizerId,
  eventId,
  initial,
  myRole,
  live = false,
  onSaved,
}: Props) {
  const t = useTranslator(language);
  const words = FEATURES[feature];
  const confirmation = useConfirmation(language);
  const titleId = `${words.path.replace("/", "-")}-title`;
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** After the shop is turned off: the prizes players still hold, or null when the count failed. */
  const [held, setHeld] = useState<Readonly<{ count: number | null }> | undefined>(undefined);

  const save = async (enabled: boolean) => {
    const before = on;
    setOn(enabled);
    setBusy(true);
    setProblem(null);
    setHeld(undefined);
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
    const saved = (result.body as Record<string, unknown>)[feature] === true;
    setOn(saved);
    onSaved?.(saved);
    if (feature === "shop" && !saved) {
      setBusy(true);
      setHeld({ count: await countHeldPrizes(organizerId, eventId) });
      setBusy(false);
    }
  };

  return (
    <Row
      as="section"
      aria-labelledby={titleId}
      main={
        <>
          <SubHeading id={titleId}>{t(words.title)}</SubHeading>
          {myRole === "owner" && on && feature === "community" ? (
            <Muted>{t("events.community.offWarning")}</Muted>
          ) : null}
          <Switch
            label={t(words.label)}
            checked={on}
            disabled={busy || myRole !== "owner"}
            onChange={(changed) => {
              const enabled = changed.target.checked;
              if (enabled || !live) {
                void save(enabled);
                return;
              }
              confirmation.ask({
                title: t("events.switchOff.title", { feature: t(words.title) }),
                body: t("events.switchOff.body"),
                confirmLabel: t("events.switchOff.confirm"),
                run: () => save(false),
              });
            }}
          />
          {problem === null ? null : (
            <Notice role="alert" tone="danger">
              {problem}
            </Notice>
          )}
          {confirmation.dialog}
          <HeldNotice language={language} held={held} />
        </>
      }
    />
  );
}
