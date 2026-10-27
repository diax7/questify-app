import { formatEventTime, formatNumber, type MessageKey, type Theme } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { Amount } from "#src/components/Amount.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { fetchActivity, type ActivityAnswer, type ActivityEntry } from "#src/event/activity-api.ts";
import { useEvent } from "#src/event/EventContext.tsx";
import { forget } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { streakHistoryLabel } from "#src/streaks/event-streak.ts";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * A signed amount with Western digits: "+10", "-50". It starts with a left-to-right mark, so an Arabic line still shows
 * the sign before the number.
 */
export const signed = (value: number, language: "ar" | "en") =>
  `\u200E${value > 0 ? "+" : value < 0 ? "-" : ""}${formatNumber(Math.abs(value), language)}`;

/** The kinds whose line names what it was for (migrations 0023, 0024); any other kind is a plain balance change. */
const TITLED: Readonly<Record<string, MessageKey>> = {
  quest: "history.quest",
  redeem: "history.redeem",
  redeem_return: "history.redeemReturn",
};

/** Kinds with a fixed label (migration 0030): the staff's reason is never shown to the player. */
const PLAIN: Readonly<Record<string, MessageKey>> = {
  welcome: "history.welcome",
  award: "history.award",
  removal: "history.removal",
  community: "history.community",
};

function entryLabel(
  entry: ActivityEntry,
  t: ReturnType<typeof useI18n>["t"],
  language: "ar" | "en",
) {
  if (entry.kind === "first_bonus" && entry.bonusSlots !== null) {
    return t("history.firstBonus", { slots: formatNumber(entry.bonusSlots, language) });
  }
  if (entry.kind === "streak" && entry.streakDays !== null) {
    return streakHistoryLabel(t, entry.streakDays);
  }
  const plain = PLAIN[entry.kind];
  if (plain !== undefined) {
    return t(plain);
  }
  const titled = TITLED[entry.kind];
  return titled === undefined || entry.title === null
    ? t("history.other")
    : t(titled, { title: textIn(entry.title, language) });
}

function EntryRow({ entry, timeZone }: Readonly<{ entry: ActivityEntry; timeZone: string }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  // The balance is what a player spends; a quest moves both the same way.
  const amount = entry.balanceDelta !== 0 ? entry.balanceDelta : entry.scoreDelta;
  return (
    <View style={styles.row}>
      <View style={styles.grow}>
        <AppText variant="label">
          {entryLabel(entry, t, language)}
          {entry.multiplier === null ? null : ` ${t("activity.boosted")}`}
        </AppText>
        <AppText muted>{formatEventTime(new Date(entry.at), timeZone, language)}</AppText>
      </View>
      <Amount amount={signed(amount, language)} form="labelled" variant="label" />
    </View>
  );
}

/**
 * The player's points record in this event (FR-410), newest first, read from the ledger page by page. Pending points
 * (FR-409) arrive with submissions (T-301).
 */
export default function HistoryScreen() {
  const { t } = useI18n();
  const { eventId, events } = useEvent();
  const [entries, setEntries] = useState<readonly ActivityEntry[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<ActivityAnswer["kind"] | "loading">("loading");
  const [busy, setBusy] = useState(false);
  // The event's own zone from the player's events; Questify's default zone until that list has loaded.
  const timeZone = events?.find((event) => event.id === eventId)?.timezone ?? "Asia/Riyadh";
  const load = useCallback(
    async (cursor: string | null) => {
      setBusy(true);
      const answer = await fetchActivity(api.session, eventId, cursor).finally(() =>
        setBusy(false),
      );
      if (answer.kind === "gone") {
        await forget(keyValueStore, eventId);
        router.replace("/home");
        return;
      }
      if (answer.kind === "signed_out") {
        router.replace("/home");
        return;
      }
      setState(answer.kind);
      if (answer.kind === "page") {
        setEntries((current) => [
          ...(cursor === null ? [] : (current ?? [])),
          ...answer.page.entries,
        ]);
        setNext(answer.page.nextCursor);
      }
    },
    [eventId],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Screen title={t("history.title")} header={<BackButton />}>
      {state === "loading" ? <AppText muted>{t("common.loading")}</AppText> : null}
      {state === "pending" ? <AppText>{t("eventHome.pending")}</AppText> : null}
      {state === "network" ? (
        <>
          <AppText accessibilityRole="alert">{t("history.failed")}</AppText>
          <Button
            label={t("common.retry")}
            onPress={() => void load(entries === undefined ? null : next)}
          />
        </>
      ) : null}
      {entries?.length === 0 ? <AppText muted>{t("history.empty")}</AppText> : null}
      <ScrollView contentContainerStyle={{ gap: 8 }}>
        {(entries ?? []).map((entry) => (
          <EntryRow key={entry.id} entry={entry} timeZone={timeZone} />
        ))}
        {next === null ? null : (
          <Button
            kind="quiet"
            label={t("home.more")}
            disabled={busy}
            onPress={() => void load(next)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  grow: { flex: 1, gap: theme.spacing.xs },
});
