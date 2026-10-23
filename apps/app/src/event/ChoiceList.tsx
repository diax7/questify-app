import type { Theme } from "@questify/shared";
import { Pressable, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import type { PlayChoice } from "#src/event/plays.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { textIn } from "#src/i18n/text.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * A vote's options or a quiz question's choices, one per row, read as a radio group. `marks` paints a choice right or
 * wrong once the answer is shown (FR-209); nothing is pressable then.
 */
export function ChoiceList({
  choices,
  chosen,
  disabled,
  onChoose,
  marks,
}: Readonly<{
  choices: readonly PlayChoice[];
  chosen: string | null;
  disabled: boolean;
  onChoose: (id: string) => void;
  marks?: Readonly<{ right: string; wrong: string | null }>;
}>) {
  const { language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityRole="radiogroup" style={styles.list}>
      {choices.map((choice) => {
        const right = marks?.right === choice.id;
        const wrong = marks?.wrong === choice.id;
        return (
          <Pressable
            key={choice.id}
            accessibilityRole="radio"
            accessibilityState={{
              checked: chosen === choice.id,
              disabled: disabled || marks !== undefined,
            }}
            disabled={disabled || marks !== undefined}
            onPress={() => onChoose(choice.id)}
            style={[
              styles.choice,
              chosen === choice.id && styles.chosen,
              right && styles.right,
              wrong && styles.wrong,
            ]}
          >
            <AppText variant="label">{textIn(choice.text, language)}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  list: { gap: theme.spacing.sm },
  choice: {
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  chosen: { borderColor: theme.colors.primaryAction },
  right: { borderColor: theme.colors.primaryAction, backgroundColor: theme.colors.surface },
  wrong: { borderColor: theme.colors.hot, backgroundColor: theme.colors.dangerSurface },
});
