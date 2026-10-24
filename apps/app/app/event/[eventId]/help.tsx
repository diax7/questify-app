import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import {
  SENDING_OFF_LINES,
  fetchMyTickets,
  markSeen,
  sendingOffFor,
  type MyTicket,
  type SendingOff,
} from "#src/event/help.ts";
import { fetchHome } from "#src/event/home-api.ts";
import { RequestList } from "#src/event/Requests.tsx";
import { initialOf } from "#src/help/center.ts";
import { TicketCenter } from "#src/help/TicketCenter.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** The player's requests in this event and whether sending is off, read on open and after each send. */
function useHelp(eventId: string, helpOn: boolean) {
  const [tickets, setTickets] = useState<MyTicket[] | undefined | "failed">(undefined);
  const [off, setOff] = useState<SendingOff | null | undefined>(undefined);
  const load = useCallback(async () => {
    const [mine, home] = await Promise.all([
      fetchMyTickets(api.session, eventId),
      fetchHome(api.session, eventId),
    ]);
    setTickets(mine ?? "failed");
    if (home.kind === "home") {
      const { standing, event } = home.home;
      setOff(
        sendingOffFor(
          { helpOn, standing: standing.status, statusNow: event.statusNow, endsAt: event.endsAt },
          Date.now(),
        ),
      );
    } else {
      // Home could not be read: the form shows unless the server said this is no longer the player's event; the server
      // checks every send again, and its refusal hides the form with the reason.
      setOff(home.kind === "gone" ? "not_member" : helpOn ? null : "feature_off");
    }
    if (mine !== undefined) {
      // Showing the list is seeing the answers on it; a failure is marked again next time.
      void markSeen(api.session, eventId, mine).catch(() => undefined);
    }
  }, [eventId, helpOn]);
  useEffect(() => {
    void load();
  }, [load]);
  return { tickets, off, setOff, load };
}

/**
 * Get help inside an event (T-310, T-312): the ticket center with this event fixed, and Your requests in every state
 * (with the switch off, after leaving, or once sending closed: only the event team's cards hide, with a line saying
 * why; App problem and Suggestion stay, as they go to Questify).
 */
export default function HelpScreen() {
  const { t } = useI18n();
  const { eventId, helpOn } = useEvent();
  const params = useLocalSearchParams<{
    card?: string;
    kind?: string;
    questId?: string;
    questTitle?: string;
  }>();
  const { tickets, off, setOff, load } = useHelp(eventId, helpOn);
  return (
    <Screen title={t("help.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <TicketCenter
          event={{ id: eventId, sendingOff: off }}
          initial={initialOf(params)}
          onSent={() => void load()}
          onOff={setOff}
        />
        {off === null || off === undefined ? null : (
          <AppText accessibilityRole="alert">{t(SENDING_OFF_LINES[off])}</AppText>
        )}
        {tickets === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {tickets === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("help.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {Array.isArray(tickets) ? <RequestList tickets={tickets} /> : null}
      </ScrollView>
    </Screen>
  );
}
