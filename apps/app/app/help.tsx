import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { readMyEvents, type MyEvent } from "#src/event/launch.ts";
import { TicketCenter } from "#src/help/TicketCenter.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The ticket center from the profile (T-312, FR-1822): App problem and Suggestion go to Questify with no event (a
 * player in no event can write); the event team's two cards ask which of the player's events, or say to join one.
 */
export default function AccountHelpScreen() {
  const { t } = useI18n();
  const [events, setEvents] = useState<MyEvent[] | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void api.session.request({ method: "GET", path: "/v1/me/events" }).then((answer) => {
      if (current) {
        setEvents((answer.kind === "ok" ? readMyEvents(answer.body) : undefined) ?? []);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return (
    <Screen title={t("help.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <TicketCenter
          event={null}
          events={events}
          onSent={() => undefined}
          onOff={() => undefined}
        />
        <Button
          kind="quiet"
          label={t("profile.requests")}
          onPress={() => router.push("/requests")}
        />
      </ScrollView>
    </Screen>
  );
}
