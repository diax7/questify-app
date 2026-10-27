import { router } from "expo-router";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { EventRow } from "#src/home/EventRow.tsx";
import { loadInvitations } from "#src/home/home-reads.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useRead } from "#src/questify/use-read.ts";

/**
 * The invitations (FR-133): events whose guest list holds the player, read again each time Home gains focus (the tabs
 * stay mounted). Nothing at all when there are none or they cannot be read.
 */
export function Invitations() {
  const { t } = useI18n();
  const invitations = useRead(() => loadInvitations(api.session), []).data ?? [];
  if (invitations.length === 0) {
    return null;
  }
  return (
    <>
      <AppText variant="title">{t("invitations.title")}</AppText>
      {invitations.map(({ event }) => (
        <EventRow
          key={event.id}
          event={{ id: event.id, joinCode: "", name: event.name }}
          note={t("invitations.open")}
          onPress={() =>
            router.push({ pathname: "/invite/[eventId]", params: { eventId: event.id } })
          }
        />
      ))}
    </>
  );
}
