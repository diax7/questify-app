import type { MessageKey, Theme } from "@questify/shared";
import { Switch, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { InfoTip } from "#src/components/InfoTip.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type Props = Readonly<{
  title: MessageKey;
  about: MessageKey;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}>;

/**
 * One setting with a switch: its name with an info button that says what it carries, and the switch (a promotional
 * channel, a push topic). The switch is named for a screen reader, so it never rests on its colour alone.
 */
export function SwitchRow({ title, about, on, disabled, onChange }: Props) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <InfoTip info={t(about)} subject={t(title)}>
          <AppText variant="label">{t(title)}</AppText>
        </InfoTip>
      </View>
      <Switch
        accessibilityLabel={t(title)}
        value={on}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: theme.colors.border, true: theme.colors.primaryAction }}
      />
    </View>
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
  text: { flex: 1, gap: theme.spacing.xs },
});
