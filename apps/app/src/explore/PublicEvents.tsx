import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { fetchPublicPage, retryCursor } from "#src/explore/public-events.ts";
import { EventRow, type ListedEvent } from "#src/home/EventRow.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** Browse before sign-in (FR-104, FR-111, FR-833): public events that list themselves, page by page. */
export function PublicEvents() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ListedEvent[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (cursor: string | null) => {
    const page = await fetchPublicPage(api.client, cursor);
    if (page.kind === "failed") {
      setFailed(true);
      return;
    }
    setFailed(false);
    setEvents((current) => [...(cursor === null ? [] : (current ?? [])), ...page.events]);
    setNext(page.next);
  }, []);
  useEffect(() => {
    void load(null);
  }, [load]);
  return (
    <>
      <AppText variant="title" accessibilityRole="header">
        {t("home.publicEvents")}
      </AppText>
      {failed ? (
        <>
          <AppText accessibilityRole="alert">{t("join.network")}</AppText>
          <Button
            kind="quiet"
            label={t("common.retry")}
            onPress={() => void load(retryCursor(events, next))}
          />
        </>
      ) : null}
      {events === undefined && !failed ? <AppText muted>{t("common.loading")}</AppText> : null}
      {events?.length === 0 ? <AppText muted>{t("home.noPublic")}</AppText> : null}
      {(events ?? []).map((event) => (
        <EventRow
          key={event.id}
          event={event}
          onPress={() =>
            router.push({
              pathname: "/join/[code]",
              params: { code: event.joinCode, via: "public_list" },
            })
          }
        />
      ))}
      {next === null ? null : (
        <Button kind="quiet" label={t("home.more")} onPress={() => void load(next)} />
      )}
    </>
  );
}
