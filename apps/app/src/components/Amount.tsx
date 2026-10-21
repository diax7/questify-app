import type { CurrencyIcon as IconName, TextVariant, Theme } from "@questify/shared";
import { Image, View, type ImageSourcePropType } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { amountLabel, knownIcon } from "#src/event/amount.ts";
import { useTerms } from "#src/event/EventContext.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** The five currency icons FR-405 names, from the brand set at 128 px. */
const ICONS: Readonly<Record<IconName, ImageSourcePropType>> = {
  coin: require("#assets/currency/coin.png"),
  crownCoin: require("#assets/currency/crownCoin.png"),
  gem: require("#assets/currency/gem.png"),
  leaf: require("#assets/currency/leaf.png"),
  star: require("#assets/currency/star.png"),
};

/** The event's currency icon. Decorative: the text beside it, or its accessibility label, names the currency. */
export function CurrencyIcon({ size }: Readonly<{ size: number }>) {
  const terms = useTerms();
  return (
    <Image
      accessibilityElementsHidden
      importantForAccessibility="no"
      source={ICONS[knownIcon(terms.currency.icon)]}
      resizeMode="contain"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * An amount in the event's currency (FR-404, FR-405): compact (the icon and the number) where space is short, such as
 * quest cards and ranking rows, or labelled (the icon, the word and the number). It is always read aloud with the word.
 */
export function Amount({
  amount,
  form,
  variant = "body",
  muted = false,
}: Readonly<{
  /** Already formatted: Western digits, a sign where it has one. */
  amount: string;
  form: "compact" | "labelled";
  variant?: TextVariant;
  muted?: boolean;
}>) {
  const { t, language } = useI18n();
  const terms = useTerms();
  const styles = useThemedStyles(makeStyles);
  const label = amountLabel(t, terms, language, amount);
  return (
    <View accessible accessibilityLabel={label} style={styles.row}>
      <CurrencyIcon size={20} />
      <AppText variant={variant} muted={muted}>
        {form === "compact" ? amount : label}
      </AppText>
    </View>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, alignItems: "center" as const, gap: theme.spacing.xs },
});
