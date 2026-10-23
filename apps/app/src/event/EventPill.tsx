import type { Language, Theme } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import type { MyEvent } from "#src/event/launch.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** An event's name in the language, else in the other one, else its code. */
export function eventName(event: Pick<MyEvent, "name" | "joinCode">, language: Language): string {
  return event.name[language] ?? event.name[language === "ar" ? "en" : "ar"] ?? event.joinCode;
}

/**
 * The pill at the top of every event tab (FR-1610, FR-624): the event's name; a tap opens a sheet with Questify home
 * and the player's other events, so leaving takes two taps.
 */
export function EventPill() {
  const { t, language } = useI18n();
  const { eventId, events, knownName } = useEvent();
  const [open, setOpen] = useState(false);
  const styles = useThemedStyles(makeStyles);
  const current = events?.find((event) => event.id === eventId);
  const name = current === undefined ? (knownName ?? "…") : eventName(current, language);
  const others = (events ?? []).filter((event) => event.id !== eventId);
  const go = (path: string) => {
    setOpen(false);
    router.replace(path);
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("eventPill.label", { name })}
        onPress={() => setOpen(true)}
        style={styles.pill}
      >
        <AppText variant="label" numberOfLines={1}>
          {name} ▾
        </AppText>
      </Pressable>
      <Sheet visible={open} title={t("eventPill.title")} onClose={() => setOpen(false)}>
        <Pressable accessibilityRole="button" onPress={() => go("/home")} style={styles.row}>
          <AppText variant="label">{t("eventPill.home")}</AppText>
        </Pressable>
        {others.map((event) => (
          <Pressable
            key={event.id}
            accessibilityRole="button"
            onPress={() => go(`/event/${event.id}`)}
            style={styles.row}
          >
            <AppText variant="label">{eventName(event, language)}</AppText>
            {event.status === "active" ? null : (
              <AppText muted>{t(`players.status.${event.status}`)}</AppText>
            )}
          </Pressable>
        ))}
      </Sheet>
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  pill: {
    alignSelf: "flex-start" as const,
    maxWidth: "100%" as const,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
