import type { Language, Theme } from "@questify/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Sheet } from "#src/components/Sheet.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import type { MyEvent } from "#src/event/launch.ts";
import { OrganizerImage } from "#src/event/OrganizerImage.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** An event's name in the language, else in the other one, else its code. */
export function eventName(event: Pick<MyEvent, "name" | "joinCode">, language: Language): string {
  return event.name[language] ?? event.name[language === "ar" ? "en" : "ar"] ?? event.joinCode;
}

/**
 * The pill at the top of every event tab (FR-1610, FR-624): the event's name; a tap opens a sheet with Questify home
 * and the player's other events, so leaving takes two taps. While Questify paused play for the event (T-703b, FR-1771) its
 * message stands under the pill on every tab.
 */
export function EventPill() {
  const { t, language } = useI18n();
  const { eventId, events, knownName, maintenance, logo } = useEvent();
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
        hitSlop={{ top: 7, bottom: 7 }}
        style={styles.pill}
      >
        {logo === null ? null : (
          <OrganizerImage
            eventId={eventId}
            imageId={logo}
            label={name}
            style={styles.logo}
            resizeMode="contain"
          />
        )}
        <AppText variant="label" numberOfLines={1} style={styles.name}>
          {name} ▾
        </AppText>
      </Pressable>
      {maintenance === null ? null : (
        <AppText accessibilityRole="alert">{maintenance[language]}</AppText>
      )}
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
  logo: { width: 24, height: 24 },
  name: { flexShrink: 1 },
  pill: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.xs,
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
