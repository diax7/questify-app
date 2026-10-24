import type { Theme } from "@questify/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Avatar } from "#src/components/Avatar.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { fetchInbox, type InboxItem } from "#src/operator/inbox.ts";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

type Loaded = Readonly<{ items: readonly InboxItem[]; next: string | null }>;

/** One card: a submission (opens the review card) or a ticket (kind, @username, quest, preview, the watch-list mark). */
function InboxCard({ eventId, item }: Readonly<{ eventId: string; item: InboxItem }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const badge =
    item.kind === "submission"
      ? t("operator.inbox.submission")
      : t(item.ticketKind === "problem" ? "operator.inbox.problem" : "operator.inbox.question");
  const open = () =>
    item.kind === "submission"
      ? router.push({ pathname: "/operator/[eventId]/review", params: { eventId, first: item.id } })
      : router.push({
          pathname: "/operator/[eventId]/ticket/[ticketId]",
          params: { eventId, ticketId: item.id },
        });
  return (
    <Pressable accessibilityRole="button" onPress={open} style={styles.card}>
      <View style={styles.row}>
        <AppText variant="label">{badge}</AppText>
        <Avatar name={item.avatar} username={item.username ?? ""} size={24} />
        <AppText>
          {item.username === null ? t("submissions.deletedPlayer") : `@${item.username}`}
        </AppText>
      </View>
      <AppText muted>
        {item.questTitle === null
          ? t("operator.inbox.eventWide")
          : textIn(item.questTitle, language)}
      </AppText>
      {item.marked ? <AppText accessibilityRole="alert">{t("tickets.marked")}</AppText> : null}
      <AppText numberOfLines={2}>{item.preview ?? t("submissions.erased")}</AppText>
    </Pressable>
  );
}

/**
 * Staff mode's Inbox (FR-927, T-310): submissions to review and help-desk requests as one list, oldest first, read on
 * every focus. With neither ability the tab says the inbox is off for this event.
 */
export default function InboxTab() {
  const { t } = useI18n();
  const { eventId, removed } = useOperator();
  const [loaded, setLoaded] = useState<Loaded | "off" | "failed" | undefined>(undefined);
  const load = useCallback(
    async (cursor: string | null) => {
      const answer = await fetchInbox(api.session, eventId, cursor);
      if (answer.kind === "removed") {
        removed();
        return;
      }
      if (answer.kind !== "inbox") {
        setLoaded(answer.kind);
        return;
      }
      setLoaded((current) => ({
        items:
          cursor !== null && typeof current === "object"
            ? [...current.items, ...answer.inbox.items]
            : answer.inbox.items,
        next: answer.inbox.nextCursor,
      }));
    },
    [eventId, removed],
  );
  useFocusEffect(
    useCallback(() => {
      void load(null);
    }, [load]),
  );
  return (
    <Screen title={t("operator.inbox")}>
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {loaded === undefined ? <AppText muted>{t("common.loading")}</AppText> : null}
        {loaded === "off" ? <AppText muted>{t("operator.inbox.off")}</AppText> : null}
        {loaded === "failed" ? (
          <>
            <AppText accessibilityRole="alert">{t("operator.inbox.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={() => void load(null)} />
          </>
        ) : null}
        {typeof loaded === "object" && loaded.items.length === 0 ? (
          <AppText muted>{t("operator.inbox.empty")}</AppText>
        ) : null}
        {typeof loaded === "object"
          ? loaded.items.map((item) => (
              <InboxCard key={`${item.kind}-${item.id}`} eventId={eventId} item={item} />
            ))
          : null}
        {typeof loaded === "object" && loaded.next !== null ? (
          <Button
            kind="quiet"
            label={t("operator.inbox.more")}
            onPress={() => void load(loaded.next)}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: "row" as const, gap: theme.spacing.sm, alignItems: "center" as const },
});
