import { router } from "expo-router";
import { useEffect, useState } from "react";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { EventRow } from "#src/home/EventRow.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { fetchInvitations, type Invitation } from "#src/join/join-api.ts";

/** The invitations (FR-133): events whose guest list holds the player; nothing at all when there are none. */
export function Invitations() {
  const { t } = useI18n();
  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  useEffect(() => {
    void fetchInvitations(api.session).then((answer) => {
      if (answer.kind === "list") {
        setInvitations(answer.invitations);
      }
    });
  }, []);
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
