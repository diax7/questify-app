import type { LocalizedText, Theme } from "@questify/shared";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type ButtonProps = Readonly<{
  label: string;
  onPress: () => void;
  kind?: "primary" | "quiet";
  disabled?: boolean;
  /** For one of a set of choices: whether it is the one chosen. */
  selected?: boolean;
  /** What a screen reader says when the visible label is not enough, such as one "Get" among many. */
  accessibilityLabel?: string;
}>;

/** One button style for the app: a primary action, or a quiet one beside it. */
export function Button({
  label,
  onPress,
  kind = "primary",
  disabled = false,
  selected,
  accessibilityLabel,
}: ButtonProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        kind === "quiet" ? styles.quiet : styles.primary,
        disabled && styles.disabled,
      ]}
    >
      <AppText variant="label">{label}</AppText>
    </Pressable>
  );
}

type FieldProps = TextInputProps & Readonly<{ label: string }>;

/** A labelled text field; the label is the field's accessible name. Values like phones and codes stay left to right. */
export function Field({ label, style, ...input }: FieldProps) {
  const styles = useThemedStyles(makeStyles);
  const { theme } = useTheme();
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        allowFontScaling={false}
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.textMuted}
        style={[styles.input, style]}
        {...input}
      />
    </View>
  );
}

/** A problem the API or the app reports, in the screen's language (every API error carries both). */
export function Problem({ problem }: Readonly<{ problem: LocalizedText | null | undefined }>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (problem === null || problem === undefined) {
    return null;
  }
  return (
    <View accessibilityRole="alert" style={styles.problem}>
      <AppText>{problem[language]}</AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  button: {
    alignItems: "center" as const,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 2,
  },
  primary: { backgroundColor: theme.colors.primaryAction, borderColor: theme.colors.primaryAction },
  quiet: { backgroundColor: "transparent", borderColor: theme.colors.border },
  disabled: { opacity: 0.5 },
  field: { gap: theme.spacing.sm },
  input: {
    borderWidth: 2,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.text,
    backgroundColor: theme.colors.surface,
  },
  problem: {
    borderWidth: 2,
    borderColor: theme.colors.hot,
    backgroundColor: theme.colors.dangerSurface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
  },
});
