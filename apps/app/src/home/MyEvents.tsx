import { router } from "expo-router";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import type { MyEvent } from "#src/event/launch.ts";
import { EventRow } from "#src/home/EventRow.tsx";
import { groupEvents, PAST_SHOWN } from "#src/home/home-groups.ts";
import { loadMyEvents, type MyEventsRead } from "#src/home/home-reads.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useRead } from "#src/questify/use-read.ts";

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

function Groups({ read }: Readonly<{ read: MyEventsRead }>) {
  const { t } = useI18n();
  const groups = groupEvents(read.events);
  return (
    <>
      <Group title={t("home.live")} events={groups.live} latest={read.latest} />
      <Group title={t("home.upcoming")} events={groups.upcoming} latest={read.latest} />
      <Group
        title={t("home.past")}
        events={groups.past.slice(0, PAST_SHOWN)}
        latest={read.latest}
      />
      {groups.past.length > PAST_SHOWN ? (
        <Button
          kind="quiet"
          label={t("eventHistory.title")}
          onPress={() => router.push("/event-history")}
        />
      ) : null}
    </>
  );
}

function MyEventsNotices({
  data,
  failed,
  retry,
}: Readonly<{ data: MyEventsRead | null; failed: boolean; retry: () => void }>) {
  const { t } = useI18n();
  return (
    <>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("home.eventsFailed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={retry} />
        </>
      ) : null}
      {data === null && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {data?.events.length === 0 ? <AppText muted>{t("home.noEvents")}</AppText> : null}
    </>
  );
}

/**
 * The player's events (FR-122, FR-832) in three groups: live now, coming up, past. Read again each time Home gains
 * focus (the tabs stay mounted), so a join or a finished event shows at once. The one opened most recently on this
 * phone is marked; pending and declined requests say so. A failed read says so with a retry: it is never shown as "no
 * events". Past events beyond the newest few are in the event history.
 */
export function MyEvents() {
  const { t } = useI18n();
  const read = useRead(() => loadMyEvents(api.session, keyValueStore), []);
  return (
    <>
      <AppText variant="title">{t("home.myEvents")}</AppText>
      <MyEventsNotices data={read.data} failed={read.failed} retry={read.retry} />
      {read.data === null ? null : <Groups read={read.data} />}
    </>
  );
}
