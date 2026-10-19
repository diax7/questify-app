import { Text, type TextProps } from "react-native";
import { useI18n } from "#src/i18n/provider.tsx";
import { colors, typography, type TextVariant } from "#src/theme/tokens.ts";

type Props = TextProps & { variant?: TextVariant; muted?: boolean };

/**
 * All text goes through this, so type and colour come from the tokens and never from a screen. Text starts where the
 * language reads from (right for Arabic) even when the app could not turn its whole layout around (Expo Go).
 */
export function AppText({ variant = "body", muted = false, style, ...rest }: Props) {
  const { rtl, textAlign } = useI18n();
  return (
    <Text
      {...rest}
      style={[
        typography[variant],
        {
          color: muted ? colors.textMuted : colors.text,
          textAlign,
          writingDirection: rtl ? "rtl" : "ltr",
        },
        style,
      ]}
    />
  );
}
