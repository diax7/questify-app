import type { Theme } from "@questify/shared";
import { Pressable } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

export type ListedEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
}>;

/** One event as a tappable row: its name in the app's language (else the other one, else its code) and a note. */
export function EventRow({
  event,
  note,
  onPress,
}: Readonly<{ event: ListedEvent; note?: string | undefined; onPress: () => void }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const name =
    event.name[language] ?? event.name[language === "ar" ? "en" : "ar"] ?? event.joinCode;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <AppText variant="label">{name}</AppText>
      {note === undefined ? null : <AppText muted>{note}</AppText>}
    </Pressable>
  );
}

const makeStyles = (theme: Theme) => ({
  row: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
