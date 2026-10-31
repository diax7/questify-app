"use client";

import { toLocalInput, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { AnnouncementSender } from "#src/components/AnnouncementSender.tsx";
import { BoostsManager } from "#src/components/BoostsPanel.tsx";
import { ControlCounters, ControlFeed, ControlQuests } from "#src/components/ControlParts.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { useQuestLiveActions } from "#src/components/useQuestLiveActions.tsx";
import { useReturnFocus } from "#src/components/useReturnFocus.ts";
import { useRoomSwitches, type RoomSwitch } from "#src/components/useRoomSwitches.tsx";
import {
  CONTROL_REFRESH_MS,
  controlViewOf,
  roomEventOf,
  type ControlView,
  type RoomEvent,
} from "#src/lib/control-room.ts";
import { requestJson } from "#src/lib/post-json.ts";
import type { QuestView } from "#src/lib/quests.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Section, Stack } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * The control room's numbers, feed and per-quest completions, read every 5 seconds while the tab is shown and once more
 * when it comes back (polling, no stream: ADR-365). A failed read keeps the last good one and says since when; one
 * read runs at a time, so a slow answer never piles requests up.
 */
function useControlView(language: Language, url: string) {
  const [view, setView] = useState<ControlView | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const reading = useRef(false);
  useEffect(() => {
    let current = true;
    const read = async () => {
      if (document.hidden || reading.current) {
        return;
      }
      reading.current = true;
      const result = await requestJson("GET", url);
      reading.current = false;
      if (!current) {
        return;
      }
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      const parsed = result.ok ? controlViewOf(result.body) : undefined;
      setFailed(parsed === undefined);
      if (parsed !== undefined) {
        setView(parsed);
        setUpdatedAt(Date.now());
      }
    };
    void read();
    const timer = setInterval(() => void read(), CONTROL_REFRESH_MS);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [language, url]);
  return { view, updatedAt, failed };
}

type Builder = ReturnType<typeof useQuestBuilder>;

/** What went wrong or is out of date, above the numbers: a failed first read, an offline poll, a refused change. */
function ControlNotices({
  language,
  builder,
  hasView,
  failed,
  since,
}: Readonly<{
  language: Language;
  builder: Builder;
  hasView: boolean;
  failed: boolean;
  since: string;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {failed ? (
        <Notice tone={hasView ? "warning" : "danger"} role={hasView ? "status" : "alert"}>
          {hasView ? t("control.offline", { time: since }) : t("control.loadFailed")}
        </Notice>
      ) : null}
      {builder.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {builder.problem}
        </Notice>
      )}
    </>
  );
}

/** The actions that run the event: double points and an announcement, each only while the event is open to change. */
function ControlActions({
  language,
  organizerId,
  eventId,
  builder,
  room,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  builder: Builder;
  room: RoomEvent;
}>) {
  const t = useTranslator(language);
  return (
    <>
      {room.boostsOn ? (
        <Section title={t("boosts.page.title")}>
          <BoostsManager language={language} organizerId={organizerId} eventId={eventId} />
        </Section>
      ) : null}
      <AnnouncementSender
        language={language}
        path={`/v1/organizers/${organizerId}/events/${eventId}/announcements`}
        zone={room.timeZone}
        disabled={builder.busy}
      />
    </>
  );
}

/** The room's sections once its first read has arrived. */
function ControlBody({
  language,
  organizerId,
  eventId,
  builder,
  live,
  view,
  room,
  toggle,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  builder: Builder;
  live: ReturnType<typeof useQuestLiveActions>;
  view: ControlView;
  room: RoomEvent;
  toggle: (kind: RoomSwitch, quest: QuestView) => void;
}>) {
  const t = useTranslator(language);
  const categories = builder.categories ?? [];
  const inOrder = new Set(
    categories
      .filter((category) => category.orderMode === "in_order")
      .map((category) => category.id),
  );
  return (
    <>
      <Section title={t("control.counters")}>
        <ControlCounters
          language={language}
          counts={view.counts}
          eventBase={`/${language}/organizers/${organizerId}/events/${eventId}`}
        />
      </Section>
      <Section title={t("control.feed")}>
        <ControlFeed language={language} feed={view.feed} timeZone={room.timeZone} />
      </Section>
      <Section title={t("quests.title")}>
        <ControlQuests
          language={language}
          timeZone={room.timeZone}
          categories={categories}
          focusQuestId={builder.focusQuestId}
          done={view.done}
          players={view.counts.players}
          busy={builder.busy}
          readOnly={room.closed}
          flashOn={room.flashOn}
          actions={live.actions}
          toggle={toggle}
          inOrder={inOrder}
          pin={(quest) =>
            void builder.send("PUT", "/focus", {
              questId: builder.focusQuestId === quest.id ? null : quest.id,
            })
          }
        />
      </Section>
      {room.closed ? null : (
        <ControlActions
          language={language}
          organizerId={organizerId}
          eventId={eventId}
          builder={builder}
          room={room}
        />
      )}
    </>
  );
}

/**
 * The live control room (T-603, FR-1024, FR-1025, FR-1028): the counters, the latest completions, every quest with its
 * completion rate and Up next pin, and the actions that run the event: flash quests, live polls, double points and an
 * announcement. Each action is the one its own page offers, drawn here; an action whose switch is off is not offered.
 * Each quest can be paused, and a step of an in-order category skipped, each after a confirmation (T-603b, FR-1026).
 */
export function ControlRoom({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const b = useQuestBuilder(language, organizerId, eventId);
  const focus = useReturnFocus("control-title");
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { view, updatedAt, failed } = useControlView(language, `${eventApi}/control`);
  const live = useQuestLiveActions({
    language,
    builder: b,
    focus,
    votesUrl: (quest) => `${eventApi}/quests/${quest.id}/votes`,
  });
  const switches = useRoomSwitches({
    language,
    builder: b,
    focus,
    behind: view?.behind ?? {},
  });
  const room = roomEventOf(b.event);
  const since =
    updatedAt === null ? "" : toLocalInput(new Date(updatedAt), room.timeZone).slice(11);

  return (
    <Stack as="section" aria-labelledby="control-title">
      <PageHeader titleId="control-title" focusable title={t("control.title")} />
      <ControlNotices
        language={language}
        builder={b}
        hasView={view !== null}
        failed={failed}
        since={since}
      />
      {room.closed ? <Muted>{t("control.ended")}</Muted> : null}
      {view === null ? null : (
        <ControlBody
          language={language}
          organizerId={organizerId}
          eventId={eventId}
          builder={b}
          live={live}
          view={view}
          room={room}
          toggle={switches.ask}
        />
      )}
      {view === null && !failed ? <Muted>{t("common.loading")}</Muted> : null}
      {live.dialogs}
      {switches.dialog}
    </Stack>
  );
}
