import type { MarketingChannel, Theme } from "@questify/shared";
import { Switch, View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { CHANNEL_TEXT } from "#src/marketing/marketing-flow.ts";
import { useTheme, useThemedStyles } from "#src/theme/theme.tsx";

type Props = Readonly<{
  channel: MarketingChannel;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}>;

/**
 * One promotional channel: its name, a line saying what it carries, and a switch that starts off. The state is also
 * said in words for a screen reader, so it never rests on the switch's colour alone.
 */
export function ChannelRow({ channel, on, disabled, onChange }: Props) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const text = CHANNEL_TEXT[channel];
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <AppText variant="label">{t(text.title)}</AppText>
        <AppText muted>{t(text.about)}</AppText>
      </View>
      <Switch
        accessibilityLabel={t(text.title)}
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
