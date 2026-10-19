import { Text, type TextProps } from "react-native";
import { useI18n } from "#src/i18n/provider.tsx";
import { colors, typography, type TextVariant } from "#src/theme/tokens.ts";

type Props = TextProps & { variant?: TextVariant; muted?: boolean };

/**
 * All text goes through this, so type and colour come from the tokens and never from a screen. No `textAlign` is set:
 * text starts at the start of its container's direction, which `Screen` sets from the language. React Native treats
 * "left" and "right" relative to that direction, so a fixed side here would be flipped twice in Arabic.
 */
export function AppText({ variant = "body", muted = false, style, ...rest }: Props) {
  const { rtl } = useI18n();
  return (
    <Text
      {...rest}
      style={[
        typography[variant],
        { color: muted ? colors.textMuted : colors.text, writingDirection: rtl ? "rtl" : "ltr" },
        style,
      ]}
    />
  );
}
