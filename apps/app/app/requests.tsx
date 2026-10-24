import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { fetchMyTickets, markSeen, type MyTicket } from "#src/event/help.ts";
import { RequestList } from "#src/event/Requests.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The profile's Your requests (T-310): every event's requests and answers, so a player who left or was removed, and
 * cannot open the event, still reads them. Showing the list marks its answers seen.
 */
export default function MyRequestsScreen() {
  const { t } = useI18n();
  const [tickets, setTickets] = useState<MyTicket[] | undefined | "failed">(undefined);
  const load = useCallback(async () => {
    const mine = await fetchMyTickets(api.session, null);
    setTickets(mine ?? "failed");
    if (mine !== undefined) {
      void markSeen(api.session, null, mine).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Screen title={t("profile.requests")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {tickets === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {tickets === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("help.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load()} />
          </>
        ) : null}
        {Array.isArray(tickets) ? <RequestList tickets={tickets} withEvent /> : null}
      </ScrollView>
    </Screen>
  );
}
