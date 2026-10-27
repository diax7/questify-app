import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { readMyEvents, readRecent, type MyEvent } from "#src/event/launch.ts";
import { EventRow } from "#src/home/EventRow.tsx";
import { groupEvents, PAST_SHOWN } from "#src/home/home-groups.ts";
import { useI18n } from "#src/i18n/provider.tsx";

function Group({
  title,
  events,
  latest,
}: Readonly<{ title: string; events: readonly MyEvent[]; latest: string | undefined }>) {
  const { t } = useI18n();
  if (events.length === 0) {
    return null;
  }
  return (
    <>
      <AppText variant="label" accessibilityRole="header">
        {title}
      </AppText>
      {events.map((event) => (
        <EventRow
          key={event.id}
          event={event}
          note={
            event.status === "pending" || event.status === "declined"
              ? t(`players.status.${event.status}`)
              : event.id === latest
                ? t("home.current")
                : undefined
          }
          onPress={() => router.replace(`/event/${event.id}`)}
        />
      ))}
    </>
  );
}

/**
 * The player's events (FR-122, FR-832) in three groups: live now, coming up, past. The one opened most recently on
 * this phone is marked; pending and declined requests say so. A failed read says so with a retry: it is never shown
 * as "no events". Past events beyond the newest few are in the event history.
 */
export function MyEvents() {
  const { t } = useI18n();
  const [events, setEvents] = useState<MyEvent[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [latest, setLatest] = useState<string | undefined>(undefined);
  const load = useCallback(async () => {
    setFailed(false);
    const answer = await api.session.request({ method: "GET", path: "/v1/me/events" });
    const read = answer.kind === "ok" ? readMyEvents(answer.body) : undefined;
    setFailed(read === undefined);
    setEvents(read);
    const recent = await readRecent(keyValueStore);
    setLatest(Object.entries(recent).sort((a, b) => b[1] - a[1])[0]?.[0]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const groups = events === undefined ? undefined : groupEvents(events);
  return (
    <>
      <AppText variant="title">{t("home.myEvents")}</AppText>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("home.eventsFailed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
        </>
      ) : null}
      {events === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {events?.length === 0 ? <AppText muted>{t("home.noEvents")}</AppText> : null}
      {groups === undefined ? null : (
        <>
          <Group title={t("home.live")} events={groups.live} latest={latest} />
          <Group title={t("home.upcoming")} events={groups.upcoming} latest={latest} />
          <Group title={t("home.past")} events={groups.past.slice(0, PAST_SHOWN)} latest={latest} />
          {groups.past.length > PAST_SHOWN ? (
            <Button
              kind="quiet"
              label={t("eventHistory.title")}
              onPress={() => router.push("/event-history")}
            />
          ) : null}
        </>
      )}
    </>
  );
}
