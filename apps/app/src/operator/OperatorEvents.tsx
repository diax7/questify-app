import type { Theme } from "@questify/shared";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { fetchOperatorEvents, type OperatorEvent } from "#src/operator/operator-api.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The events this person staffs (FR-907), each opening Operator mode. Shown only when there are some: most players
 * staff nothing, and a failed read simply shows nothing here (their player events still show below).
 */
export function OperatorEvents() {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [events, setEvents] = useState<readonly OperatorEvent[]>([]);
  const load = useCallback(async () => {
    const answer = await fetchOperatorEvents(api.session);
    if (answer.kind === "events") {
      setEvents(answer.events);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (events.length === 0) {
    return null;
  }
  return (
    <>
      <AppText variant="title">{t("operator.mode")}</AppText>
      {events.map((event) => (
        <Pressable
          key={event.eventId}
          accessibilityRole="button"
          onPress={() => router.push(`/operator/${event.eventId}`)}
          style={styles.row}
        >
          <AppText variant="label">{textIn(event.name, language)}</AppText>
          <AppText muted>{t("operator.badge")}</AppText>
        </Pressable>
      ))}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.primaryAction,
    backgroundColor: theme.colors.surface,
  },
});
