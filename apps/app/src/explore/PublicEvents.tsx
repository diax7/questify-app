import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { EventRow, type ListedEvent } from "#src/home/EventRow.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

const isText = (value: unknown): value is ListedEvent["name"] =>
  typeof value === "object" && value !== null && "ar" in value && "en" in value;

/** The listed events that have the fields a row needs; an entry of another shape is left out. */
export const listedEvents = (value: unknown): ListedEvent[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is ListedEvent =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as ListedEvent).id === "string" &&
          typeof (item as ListedEvent).joinCode === "string" &&
          isText((item as ListedEvent).name),
      )
    : [];

/** Browse before sign-in (FR-104, FR-111, FR-833): public events that list themselves, page by page. */
export function PublicEvents() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ListedEvent[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (cursor: string | null) => {
    const path =
      cursor === null
        ? "/v1/public/events"
        : `/v1/public/events?cursor=${encodeURIComponent(cursor)}`;
    const answer = await api.client.request({ method: "GET", path });
    if (answer.kind !== "ok" || typeof answer.body !== "object" || answer.body === null) {
      // A failed read is not an empty list: say so, with retry.
      setFailed(true);
      return;
    }
    setFailed(false);
    const body = answer.body as { events?: unknown; nextCursor?: unknown };
    setEvents((current) => [
      ...(cursor === null ? [] : (current ?? [])),
      ...listedEvents(body.events),
    ]);
    // The cursor is opaque (API.md): sent back as it came; a stale one starts again from the first page.
    setNext(typeof body.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : null);
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
            onPress={() => void load(events === undefined ? null : next)}
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
